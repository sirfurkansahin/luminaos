import { useEffect, useState } from 'react';

import {
  getDesktopSignalConsent,
  grantDesktopSignalConsent,
  revokeDesktopSignalConsent,
} from '../api/http-client.js';
import { getWorkspaceId } from '../workspace-context.js';

const SIGNAL_TYPES = ['calendar-status', 'active-window'] as const;

type DesktopSignalType = (typeof SIGNAL_TYPES)[number];

const SIGNAL_LABELS: Record<DesktopSignalType, string> = {
  'calendar-status': 'Takvim durumu (meşgul/müsait)',
  'active-window': 'Aktif pencere uygulaması',
};

/**
 * Rıza yönetimi paneli (F2-T3 PR4, ADR-0020 Karar a) — her masaüstü sinyal
 * türü için bağımsız bir aç/kapa anahtarı. `../workspace-context.ts` üzerinden
 * okunan workspace kimliği, gerçek oturum açma/workspace seçim arayüzü
 * F2-T3b'ye ertelendiği için MEVCUT bir oturuma bağımlıdır.
 */
export function ConsentSettings(): React.JSX.Element {
  const [consentState, setConsentState] = useState<Record<DesktopSignalType, boolean>>({
    'calendar-status': false,
    'active-window': false,
  });

  useEffect(() => {
    const workspaceId = getWorkspaceId();
    if (workspaceId === null) {
      return;
    }

    let cancelled = false;

    void Promise.all(
      SIGNAL_TYPES.map(async (signalType) => {
        const consent = await getDesktopSignalConsent(workspaceId, signalType);
        return [signalType, consent !== null && consent.revokedAt === null] as const;
      }),
    ).then((entries) => {
      if (cancelled) {
        return;
      }
      setConsentState((previous) => ({ ...previous, ...Object.fromEntries(entries) }));
    });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleToggle(signalType: DesktopSignalType): Promise<void> {
    const workspaceId = getWorkspaceId();
    if (workspaceId === null) {
      return;
    }

    const isCurrentlyOn = consentState[signalType];
    const consent = isCurrentlyOn
      ? await revokeDesktopSignalConsent(workspaceId, signalType)
      : await grantDesktopSignalConsent(workspaceId, signalType);

    setConsentState((previous) => ({
      ...previous,
      [signalType]: consent.revokedAt === null,
    }));
  }

  return (
    <section>
      <h2>Masaüstü sinyal izinleri</h2>
      <ul>
        {SIGNAL_TYPES.map((signalType) => (
          <li key={signalType}>
            <span>{SIGNAL_LABELS[signalType]}</span>
            <button
              type="button"
              role="switch"
              aria-checked={consentState[signalType]}
              data-testid={`consent-toggle-${signalType}`}
              onClick={() => {
                void handleToggle(signalType);
              }}
            >
              {consentState[signalType] ? 'Açık' : 'Kapalı'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
