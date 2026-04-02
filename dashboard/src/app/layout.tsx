import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'NanoClaw Dashboard',
  description: 'Monitor agents, tasks, and messages',
};

const NAV_LINKS = [
  { href: '/', label: 'Status' },
  { href: '/organisation', label: 'Organisation' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/messages', label: 'Messages' },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-gray-950 text-gray-100 font-mono">
        <nav className="border-b border-gray-800 px-6 py-3 flex items-center gap-6">
          <span className="font-bold text-emerald-400 tracking-tight">NanoClaw</span>
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm text-gray-400 hover:text-gray-100 transition-colors"
            >
              {link.label}
            </a>
          ))}
        </nav>
        <main className="px-6 py-6 max-w-6xl mx-auto">{children}</main>
      </body>
    </html>
  );
}
