import localFont from 'next/font/local';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata = {
    title: 'ARA Backtester — 레버리지 ETF 200일선 투자법',
    description: '레버리지 ETF 200일선 기반 투자 전략 백테스터: 집중투자 · 배수익절 · 딥바잉',
};

export default function RootLayout({ children }) {
    return (
        <html lang="ko">
            <head>
                <link rel="preconnect" href="https://fonts.googleapis.com" />
            </head>
            <body className={inter.variable}>{children}</body>
        </html>
    );
}
