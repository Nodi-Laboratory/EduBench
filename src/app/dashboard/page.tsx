import type { Metadata } from 'next';
import { ResearchControlRoom } from '@/components/research-control-room';

export const metadata: Metadata = { title: 'Research Control Room' };

export default function DashboardPage() {
  return <ResearchControlRoom />;
}
