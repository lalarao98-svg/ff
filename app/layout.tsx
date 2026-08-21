import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FieldEdge · Fantasy Football Analytics",
  description:
    "Monte Carlo weekly projections and a multi-season draft pipeline on nflverse-data: robust averaging, value over replacement, risk, and roster optimization.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
