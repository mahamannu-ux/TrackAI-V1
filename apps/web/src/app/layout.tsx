import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TrackAI - Dashboard',
  description: 'TrackAI MVP - Decoupled architecture with Supabase Auth',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
