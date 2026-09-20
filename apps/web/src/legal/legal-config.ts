function configuredValue(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export const legalConfig = {
  controllerName: configuredValue(
    import.meta.env['VITE_LEGAL_CONTROLLER_NAME'],
    'Muhammed Furkan ŞAHİN',
  ),
  contactEmail: configuredValue(
    import.meta.env['VITE_LEGAL_CONTACT_EMAIL'],
    'sir.furkansahin@gmail.com',
  ),
  effectiveDate: '21 Eylül 2026',
} as const;
