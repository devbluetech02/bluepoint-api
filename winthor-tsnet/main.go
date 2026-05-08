// winthor-tsnet — TCP relay para o gateway Oracle do Winthor.
//
// Substitui o stack tailscaled (userspace SOCKS5) + gost (TCP→SOCKS5 relay)
// que rodava no container do Fargate. A vantagem do tsnet é ter UM único hop
// userspace: o binary joina diretamente na tailnet via biblioteca embarcada e
// disca para o peer Tailscale (winthor-bridge-pc) sem passar por SOCKS5.
//
// Fluxo:
//   API (oracledb) → 127.0.0.1:30492
//                  → winthor-tsnet aceita conexão
//                  → tsnet.Server.Dial("tcp", $WINTHOR_BRIDGE)
//                  → wireguard userspace → winthor-bridge-pc:30492
//                  → socat WSL → cloud-7445.reposit.com.br:30492
//                  → Oracle Winthor
//
// Hipótese de design: o ORA-12547 que aparecia com gost+SOCKS5 vinha do
// SOCKS5 quebrar o handshake do Oracle (TNS redirect / idle close). Sem
// SOCKS5 no caminho, o stream TCP fica cru entre Fargate e o PC bridge.
//
// Variáveis de ambiente:
//   TS_AUTHKEY        — auth key reusable da tailnet (obrigatório)
//   TS_HOSTNAME       — hostname do node na tailnet (default: people-api-fargate-tsnet)
//   TS_STATE_DIR      — diretório de estado do tsnet (default: /var/lib/tsnet)
//   WINTHOR_BRIDGE    — endereço destino na tailnet (default: 100.121.93.39:30492)
//   LISTEN_ADDR       — onde escutar conexões locais (default: 127.0.0.1:30492)
package main

import (
	"context"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"tailscale.com/tsnet"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	authKey := os.Getenv("TS_AUTHKEY")
	if authKey == "" {
		log.Fatalf("[winthor-tsnet] TS_AUTHKEY vazia — abortando")
	}

	hostname := envOr("TS_HOSTNAME", "people-api-fargate-tsnet")
	stateDir := envOr("TS_STATE_DIR", "/var/lib/tsnet")
	bridge := envOr("WINTHOR_BRIDGE", "100.121.93.39:30492")
	listenAddr := envOr("LISTEN_ADDR", "127.0.0.1:30492")

	if err := os.MkdirAll(stateDir, 0700); err != nil {
		log.Fatalf("[winthor-tsnet] mkdir state dir: %v", err)
	}

	srv := &tsnet.Server{
		Hostname:  hostname,
		AuthKey:   authKey,
		Dir:       stateDir,
		Ephemeral: true, // node some da tailnet quando o container morre
		Logf:      func(format string, args ...any) { log.Printf("[tsnet] "+format, args...) },
	}
	defer srv.Close()

	// Bloqueia até o nó estar Running na tailnet (timeout 60s).
	bootCtx, bootCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer bootCancel()
	if _, err := srv.Up(bootCtx); err != nil {
		log.Fatalf("[winthor-tsnet] tsnet up: %v", err)
	}
	log.Printf("[winthor-tsnet] tailnet OK hostname=%s bridge=%s", hostname, bridge)

	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		log.Fatalf("[winthor-tsnet] listen %s: %v", listenAddr, err)
	}
	defer ln.Close()
	log.Printf("[winthor-tsnet] escutando %s → %s", listenAddr, bridge)

	// SIGINT/SIGTERM derruba listener — Fargate envia SIGTERM no scale-down.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Printf("[winthor-tsnet] sinal recebido, fechando listener")
		ln.Close()
	}()

	for {
		client, err := ln.Accept()
		if err != nil {
			// listener fechado por sinal — sai limpo.
			if ne, ok := err.(net.Error); ok && !ne.Temporary() {
				log.Printf("[winthor-tsnet] accept fim: %v", err)
				return
			}
			log.Printf("[winthor-tsnet] accept erro: %v", err)
			continue
		}
		go handle(srv, client, bridge)
	}
}

func handle(srv *tsnet.Server, client net.Conn, bridge string) {
	defer client.Close()

	// Dial via tsnet — passa pela wireguard userspace, sem SOCKS5.
	dialCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	upstream, err := srv.Dial(dialCtx, "tcp", bridge)
	if err != nil {
		log.Printf("[winthor-tsnet] dial %s: %v", bridge, err)
		return
	}
	defer upstream.Close()

	// TCP keepalive nos dois lados — Oracle session pode ficar idle.
	if tc, ok := upstream.(*net.TCPConn); ok {
		tc.SetKeepAlive(true)
		tc.SetKeepAlivePeriod(30 * time.Second)
	}
	if tc, ok := client.(*net.TCPConn); ok {
		tc.SetKeepAlive(true)
		tc.SetKeepAlivePeriod(30 * time.Second)
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go pipe(&wg, client, upstream, "client→bridge")
	go pipe(&wg, upstream, client, "bridge→client")
	wg.Wait()
}

// pipe copia até EOF/erro e força close do destino — sem isso, um lado
// fechando deixa o outro pendurado segurando o handshake do Oracle.
func pipe(wg *sync.WaitGroup, dst io.WriteCloser, src io.Reader, tag string) {
	defer wg.Done()
	if _, err := io.Copy(dst, src); err != nil && err != io.EOF {
		log.Printf("[winthor-tsnet] %s copy: %v", tag, err)
	}
	if c, ok := dst.(interface{ CloseWrite() error }); ok {
		c.CloseWrite()
	} else {
		dst.Close()
	}
}
