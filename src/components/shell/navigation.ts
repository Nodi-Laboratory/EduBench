import type { LucideIcon } from 'lucide-react';
import {
  BarChart3,
  BookOpen,
  ClipboardCheck,
  Database,
  FlaskConical,
  LayoutDashboard,
  PlayCircle,
  Settings,
  Sparkles,
} from 'lucide-react';

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  group: '운영' | '설정';
};

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: '운영 현황', icon: LayoutDashboard, group: '운영' },
  { href: '/document-lab', label: 'Document Lab', icon: FlaskConical, group: '운영' },
  { href: '/sources', label: '교과서 자료 관리', icon: BookOpen, group: '운영' },
  { href: '/generation', label: '질문 생성', icon: Sparkles, group: '운영' },
  { href: '/review', label: '질문 검수', icon: ClipboardCheck, group: '운영' },
  { href: '/datasets', label: '데이터셋 관리', icon: Database, group: '운영' },
  { href: '/runs', label: '벤치마크 실행', icon: PlayCircle, group: '운영' },
  { href: '/results', label: '결과 분석', icon: BarChart3, group: '운영' },
  { href: '/settings', label: '시스템 설정', icon: Settings, group: '설정' },
] as const;

