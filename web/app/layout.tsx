import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: '智萃科研 · 让研究有据可循',
  description: '从已有材料出发，在对话中完成你需要的科研成果。',
  icons: { icon: '/icon.svg' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
