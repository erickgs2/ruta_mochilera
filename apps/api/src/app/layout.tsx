export const metadata = {
  title: 'Ruta Mochilera API',
  description: 'API-only Next.js app serving /api/v1/** route handlers.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
