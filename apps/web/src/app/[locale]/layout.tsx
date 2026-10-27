import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { LOCALES, directionOf, isLocale, translate } from '@ftth/i18n';
import { toCssVariables } from '@ftth/ui-tokens';
import { LanguageSwitcher } from '@/shared/i18n/language-switcher';
import { Providers } from '@/shared/i18n/providers';
import '../globals.css';

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  return isLocale(locale) ? { title: translate(locale, 'common.appName') } : {};
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <html lang={locale} dir={directionOf(locale)}>
      <head>
        <style dangerouslySetInnerHTML={{ __html: toCssVariables() }} />
      </head>
      <body>
        <Providers locale={locale}>
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-(--color-border) px-4 py-2">
            <span className="font-semibold">{translate(locale, 'common.appName')}</span>
            <LanguageSwitcher />
          </header>
          <main className="flex justify-center p-4">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
