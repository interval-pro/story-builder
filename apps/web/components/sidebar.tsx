'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Stories' },
  { href: '/brain', label: 'Project Brain' },
  { href: '/knowledge', label: 'Project Knowledge' },
  { href: '/system', label: 'System Status' },
];

export function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="sidebar">
      <h1>AI Engineering</h1>
      <div className="tagline">Cockpit</div>
      <nav>
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} className={pathname === link.href ? 'active' : ''}>
            {link.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
