import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Composio integration audit — 100 apps, two access gates",
  description: "An evidence-first audit of 100 apps for agent toolkit buildability, access, MCP capability, and Composio opportunity.",
  applicationName: "Composio Integration Audit",
  keywords: ["Composio", "Product Ops", "MCP", "agent toolkit", "API audit"]
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
