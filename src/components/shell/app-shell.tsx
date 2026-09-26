import type { ReactNode } from 'react';
import { getCurrentUser } from '@/server/auth/current-user';
import { MockProvidersProvider } from '@/hooks/use-mock-providers';
import { isMockProviders } from '@/server/providers/credentials';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';
import { UserMenu } from './user-menu';

export async function AppShell({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  // The proxy only lets signed-out requests reach /login and /signup, which
  // render without the workspace chrome.
  if (!user) return <>{children}</>;
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <Topbar userMenu={<UserMenu displayName={user.displayName} username={user.username} />} />
        <main className="page-canvas">
          <MockProvidersProvider value={isMockProviders()}>{children}</MockProvidersProvider>
        </main>
      </div>
    </div>
  );
}
