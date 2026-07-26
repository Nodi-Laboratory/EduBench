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
  group: NavGroup;
};

export const NAV_GROUPS = [
  'Monitor',
  'Corpus',
  'Question Pipeline',
  'Experiments',
  'Methods',
] as const;

export type NavGroup = typeof NAV_GROUPS[number];

export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/dashboard', label: 'Research Control Room', icon: LayoutDashboard, group: 'Monitor' },
  { href: '/document-lab', label: 'Document Lab', icon: FlaskConical, group: 'Corpus' },
  { href: '/sources', label: '교과서 자료 관리', icon: BookOpen, group: 'Corpus' },
  { href: '/generation', label: '질문 생성', icon: Sparkles, group: 'Question Pipeline' },
  { href: '/review', label: '질문 검수', icon: ClipboardCheck, group: 'Question Pipeline' },
  { href: '/datasets', label: '데이터셋 관리', icon: Database, group: 'Question Pipeline' },
  { href: '/runs', label: '벤치마크 실행', icon: PlayCircle, group: 'Experiments' },
  { href: '/results', label: '결과 분석', icon: BarChart3, group: 'Experiments' },
  { href: '/settings', label: '시스템 설정', icon: Settings, group: 'Methods' },
] as const;

