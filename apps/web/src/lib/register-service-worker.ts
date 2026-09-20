export interface ServiceWorkerRegistrar {
  register(scriptURL: string, options?: RegistrationOptions): Promise<unknown>;
}

export async function registerServiceWorker(
  registrar: ServiceWorkerRegistrar | undefined,
  isProduction: boolean,
): Promise<boolean> {
  if (!isProduction || registrar === undefined) {
    return false;
  }

  try {
    await registrar.register('/sw.js', { scope: '/' });
    return true;
  } catch (error: unknown) {
    console.error('Service worker registration failed', error);
    return false;
  }
}
