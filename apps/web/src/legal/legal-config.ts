function configuredValue(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export const legalConfig = {
  controllerName: configuredValue(
    import.meta.env['VITE_LEGAL_CONTROLLER_NAME'],
    'LuminaOS kapalı beta işletmecisi',
  ),
  contactEmail: configuredValue(
    import.meta.env['VITE_LEGAL_CONTACT_EMAIL'],
    'Yayın öncesi yapılandırılacaktır',
  ),
  effectiveDate: '21 Eylül 2026',
} as const;
