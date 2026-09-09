import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '../components/sidebar';

export const metadata: Metadata = {
  title: 'AI Engineering Cockpit',
  description: 'An engineering process in which AI participates as multiple engineers.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="layout">
          <Sidebar />
          <main className="content">{children}</main>
        </div>
      </body>
    </html>
  );
}
