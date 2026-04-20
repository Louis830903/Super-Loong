import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/layout/sidebar";
import { ToastContainer } from "@/components/ui/toast";
import Script from "next/script";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Super Agent",
  description: "AI Agent 管理平台",
};

// Inline script to apply theme from localStorage before first paint (prevents flash)
const themeScript = `
(function() {
  try {
    var raw = localStorage.getItem("super-agent.ui-prefs.v1");
    if (raw) {
      var prefs = JSON.parse(raw);
      if (prefs.theme === "light") {
        document.documentElement.classList.remove("dark");
      } else if (prefs.theme === "system") {
        if (!window.matchMedia("(prefers-color-scheme: dark)").matches) {
          document.documentElement.classList.remove("dark");
        }
      }
    }
  } catch(e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full bg-background text-foreground">
        <Sidebar />
        <main className="main-content min-h-screen transition-all duration-200">
          <div className="p-6 lg:p-8">{children}</div>
        </main>
        <ToastContainer />
      </body>
    </html>
  );
}
