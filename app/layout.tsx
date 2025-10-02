import type { Metadata } from 'next';
import './globals.css';
import '../styles/globals.css';

export const metadata: Metadata = {
  title: 'Advanced Analytics Dashboard',
  description: 'Behavioral analytics powered by Next.js and MongoDB'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
