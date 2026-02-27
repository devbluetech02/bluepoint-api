export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { iniciarAlertasPeriodicos } = await import('@/lib/alertas-periodicos');
    iniciarAlertasPeriodicos();
  }
}
