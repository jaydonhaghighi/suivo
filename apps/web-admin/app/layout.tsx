import type { ReactNode } from 'react';
import Link from 'next/link';

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: 'ui-sans-serif, system-ui, -apple-system',
          background: 'linear-gradient(180deg, #F5F2E8 0%, #E8EFE9 100%)',
          minHeight: '100vh'
        }}
      >
        <nav
          style={{
            display: 'flex',
            gap: 12,
            padding: 16,
            borderBottom: '1px solid #d8d2c7',
            background: '#ffffffcc',
            backdropFilter: 'blur(4px)'
          }}
        >
          <Link href="/">Dashboard</Link>
          <Link href="/admin">Admin</Link>
          <Link href="/rescue">Rescue</Link>
          <Link href="/templates">Templates</Link>
          <Link href="/rules">Rules</Link>
        </nav>
        <main style={{ maxWidth: 1000, margin: '0 auto', padding: 20 }}>{children}</main>
      </body>
    </html>
  );
}
