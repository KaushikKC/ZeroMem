import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'ZeroMem — Git-for-Agent-Memory on 0G',
  description: 'Versioned, encrypted, multi-agent memory layer built on 0G Storage + Compute',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
