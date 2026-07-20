import type { Metadata } from 'next';
import { DocumentLabWorkspace } from '@/components/document-lab/document-lab-workspace';

export const metadata: Metadata = { title: 'Document Lab' };

export default function DocumentLabPage() {
  return <DocumentLabWorkspace />;
}
