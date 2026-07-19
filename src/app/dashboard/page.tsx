import type { Metadata } from 'next';
import { DashboardOverview } from '@/components/dashboard/dashboard-overview';

export const metadata: Metadata = { title: '운영 현황' };

export default function DashboardPage() {
  return <DashboardOverview />;
}

