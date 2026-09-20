import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import {
  createDeletionRequest,
  getLatestDataRightsRequest,
  getWorkspaceExportUrl,
} from '../lib/apiClient';

const DATA_RIGHTS_QUERY_KEY = ['data-rights-request'] as const;

function formatRequestDate(value: string): string {
  return new Intl.DateTimeFormat('tr-TR', {
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function DataRightsPanel({ workspaceId }: { workspaceId: string }) {
  const [confirmed, setConfirmed] = useState(false);
  const queryClient = useQueryClient();
  const requestQuery = useQuery({
    queryKey: DATA_RIGHTS_QUERY_KEY,
    queryFn: getLatestDataRightsRequest,
  });
  const requestMutation = useMutation({
    mutationFn: createDeletionRequest,
    onSuccess: (result) => {
      queryClient.setQueryData(DATA_RIGHTS_QUERY_KEY, result);
      setConfirmed(false);
    },
  });
  const deletionRequest = requestQuery.data?.request;

  return (
    <section className="settings-card" aria-labelledby="data-rights-heading">
      <h2 id="data-rights-heading">Veri hakları</h2>
      <p>Bu çalışma alanında erişebildiğiniz verileri taşınabilir JSON olarak indirebilirsiniz.</p>
      <a href={getWorkspaceExportUrl(workspaceId)} download>
        JSON verilerimi indir
      </a>
      <h3>Hesap silme talebi</h3>
      <p>
        Silme talebi kayda alındıktan sonra en kısa sürede ve en geç 30 gün içinde sonuçlandırılır.
      </p>
      {requestQuery.isLoading && <p role="status">Talep durumu yükleniyor…</p>}
      {requestQuery.isError && (
        <p className="form-error" role="alert">
          Talep durumu alınamadı. Lütfen sayfayı yenileyin.
        </p>
      )}
      {deletionRequest ? (
        <div className="data-rights-request" role="status">
          <strong>
            {deletionRequest.status === 'pending'
              ? 'Silme talebiniz incelemede'
              : 'Son silme talebiniz sonuçlandı'}
          </strong>
          <span>Takip numarası: {deletionRequest.id}</span>
          <span>Talep zamanı: {formatRequestDate(deletionRequest.requestedAt)}</span>
        </div>
      ) : (
        <form
          className="data-rights-form"
          onSubmit={(event) => {
            event.preventDefault();
            requestMutation.mutate();
          }}
        >
          <label className="confirmation-row">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => {
                setConfirmed(event.target.checked);
              }}
            />
            Hesabımın ve kişisel verilerimin silinmesini talep ettiğimi anlıyorum.
          </label>
          {requestMutation.isError && (
            <p className="form-error" role="alert">
              Talep kaydedilemedi. Lütfen tekrar deneyin.
            </p>
          )}
          <button
            className="primary-button"
            type="submit"
            disabled={!confirmed || requestMutation.isPending}
          >
            {requestMutation.isPending ? 'Kaydediliyor…' : 'Silme talebi oluştur'}
          </button>
        </form>
      )}
      <nav className="legal-links" aria-label="Hukuki belgeler">
        <a href="/?legal=privacy">Aydınlatma metni</a>
        <a href="/?legal=terms">Kullanım koşulları</a>
      </nav>
    </section>
  );
}
