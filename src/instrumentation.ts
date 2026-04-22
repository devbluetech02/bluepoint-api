export async function register() {
  console.log('[Instrumentation] register() chamado, NEXT_RUNTIME=' + process.env.NEXT_RUNTIME);
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log('[Instrumentation] Iniciando alertas periódicos...');
    const { iniciarAlertasPeriodicos } = await import('@/lib/alertas-periodicos');
    iniciarAlertasPeriodicos();
    console.log('[Instrumentation] Alertas periódicos iniciados.');

    console.log('[Instrumentation] Iniciando SignProof status checker...');
    const { iniciarSignProofStatusChecker } = await import('@/lib/signproof-status-checker');
    iniciarSignProofStatusChecker();
    console.log('[Instrumentation] SignProof status checker iniciado.');
  }
}
