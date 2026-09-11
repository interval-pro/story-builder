import type { Metadata } from 'next';
import './globals.css';
import { Shell } from '../components/shell';

export const metadata: Metadata = {
  title: 'Story Builder',
  description: 'An engineering process in which AI participates as several engineers.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
