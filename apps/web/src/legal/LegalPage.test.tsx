import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { LegalPage } from './LegalPage';

describe('LegalPage', () => {
  it('renders the KVKK disclosure sections and a route back to login', () => {
    render(<LegalPage document="privacy" />);

    expect(screen.getByRole('heading', { name: 'Kişisel Veriler Aydınlatma Metni' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Veri sorumlusu' })).toBeVisible();
    expect(screen.getByText('Muhammed Furkan ŞAHİN')).toBeVisible();
    expect(screen.getByText(/sir\.furkansahin@gmail\.com/)).toBeVisible();
    expect(
      screen.getByRole('heading', { name: 'İşleme amaçları ve hukuki sebepler' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Haklarınız' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Giriş ekranına dön' })).toHaveAttribute('href', '/');
  });

  it('renders beta terms separately from the privacy notice', () => {
    render(<LegalPage document="terms" />);

    expect(screen.getByRole('heading', { name: 'Kapalı Beta Kullanım Koşulları' })).toBeVisible();
    expect(
      screen.getByText(/üretim garantisi veya kesintisiz hizmet taahhüdü vermez/i),
    ).toBeVisible();
  });
});
