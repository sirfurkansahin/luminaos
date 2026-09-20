import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError, changePassword } from '../lib/apiClient';

import type { SyntheticEvent } from 'react';

function passwordErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.statusCode === 401) {
    return 'Mevcut parola hatalı.';
  }
  if (error instanceof ApiError && error.statusCode === 429) {
    return 'Çok fazla deneme yapıldı. Lütfen bir süre sonra tekrar deneyin.';
  }
  return 'Parola değiştirilemedi. Lütfen tekrar deneyin.';
}

export function ChangePasswordPanel() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [clientError, setClientError] = useState<string | undefined>();
  const [succeeded, setSucceeded] = useState(false);
  const mutation = useMutation({
    mutationFn: () => changePassword(currentPassword, newPassword),
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      setClientError(undefined);
      setSucceeded(true);
    },
  });

  const handleSubmit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setSucceeded(false);
    mutation.reset();
    if (newPassword !== confirmation) {
      setClientError('Yeni parola ve tekrarı eşleşmiyor.');
      return;
    }
    setClientError(undefined);
    mutation.mutate();
  };

  return (
    <section className="account-security" aria-labelledby="password-security-heading">
      <h2 id="password-security-heading">Parola güvenliği</h2>
      <p>Yeni parolanız en az 12 karakter olmalıdır.</p>
      <form className="auth-form account-security__form" onSubmit={handleSubmit}>
        <label htmlFor="current-password">Mevcut parola</label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          required
          minLength={8}
          maxLength={200}
          value={currentPassword}
          onChange={(event) => {
            setCurrentPassword(event.target.value);
          }}
        />
        <label htmlFor="new-password">Yeni parola</label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={200}
          value={newPassword}
          onChange={(event) => {
            setNewPassword(event.target.value);
          }}
        />
        <label htmlFor="new-password-confirmation">Yeni parola tekrarı</label>
        <input
          id="new-password-confirmation"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={200}
          value={confirmation}
          onChange={(event) => {
            setConfirmation(event.target.value);
          }}
        />
        {(clientError !== undefined || mutation.isError) && (
          <p className="form-error" role="alert">
            {clientError ?? passwordErrorMessage(mutation.error)}
          </p>
        )}
        {succeeded && (
          <p className="form-success" role="status">
            Parolanız güncellendi. Diğer açık oturumlar kapatıldı.
          </p>
        )}
        <button className="primary-button" type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? 'Güncelleniyor…' : 'Parolayı değiştir'}
        </button>
      </form>
    </section>
  );
}
