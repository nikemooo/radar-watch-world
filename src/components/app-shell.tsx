import { Link, useNavigate, useRouterState, type LinkProps } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  CreditCard,
  LayoutDashboard,
  type LucideIcon,
  Newspaper,
  Radar as RadarIcon,
  Settings,
  Shield,
  LogOut,
  Plus,
} from "lucide-react";
import type { ReactNode } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/radar-mark";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

interface NavItem {
  to: NonNullable<LinkProps["to"]>;
  label: string;
  icon: LucideIcon;
}

const primaryNav: NavItem[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/radars", label: "My Radars", icon: RadarIcon },
  { to: "/alerts", label: "Alerts", icon: Bell },
  { to: "/intelligence", label: "Intelligence", icon: Newspaper },
  { to: "/billing", label: "Billing", icon: CreditCard },
];

const secondaryNav: NavItem[] = [{ to: "/settings", label: "Settings", icon: Settings }];

// Compact bottom-bar set for phones (labels shortened to fit).
const mobileNav: (NavItem & { short: string })[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, short: "Home" },
  { to: "/radars", label: "My Radars", icon: RadarIcon, short: "Radars" },
  { to: "/alerts", label: "Alerts", icon: Bell, short: "Alerts" },
  { to: "/billing", label: "Billing", icon: CreditCard, short: "Billing" },
  { to: "/settings", label: "Settings", icon: Settings, short: "Settings" },
];

export function useIsAdmin() {
  return useQuery({
    queryKey: ["is-admin"],
    queryFn: async () => {
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return false;
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", userData.user.id)
        .eq("role", "admin")
        .maybeSingle();
      return Boolean(data);
    },
  });
}

export function useUnreadAlerts() {
  return useQuery({
    queryKey: ["alerts", "unread-count"],
    queryFn: async () => {
      const { count } = await supabase
        .from("alerts")
        .select("id", { count: "exact", head: true })
        .eq("status", "new");
      return count ?? 0;
    },
  });
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: isAdmin } = useIsAdmin();
  const { data: unread } = useUnreadAlerts();

  const nav = isAdmin
    ? [...primaryNav, { to: "/admin", label: "Admin", icon: Shield } satisfies NavItem]
    : primaryNav;

  const signOut = async () => {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  };

  return (
    <div className="min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-sidebar px-3 py-4 lg:flex">
        <Link to="/dashboard" className="px-2 py-1">
          <Wordmark />
        </Link>
        <div className="mt-6">
          <Button asChild className="w-full justify-start gap-2">
            <Link to="/radars/new">
              <Plus className="size-4" />
              Create Radar
            </Link>
          </Button>
        </div>
        <nav className="mt-6 flex flex-1 flex-col gap-1">
          {nav.map((item) => (
            <NavLink key={item.to} item={item} active={pathname.startsWith(item.to)} badge={item.to === "/alerts" ? unread : 0} />
          ))}
          <div className="mt-auto flex flex-col gap-1">
            {secondaryNav.map((item) => (
              <NavLink key={item.to} item={item} active={pathname.startsWith(item.to)} />
            ))}
            <button
              onClick={signOut}
              className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            >
              <LogOut className="size-4" />
              Sign out
            </button>
          </div>
        </nav>
      </aside>

      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-background/85 px-4 py-3 backdrop-blur lg:hidden">
        <Link to="/dashboard">
          <Wordmark />
        </Link>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <Button variant="ghost" size="icon" onClick={signOut} aria-label="Sign out">
            <LogOut className="size-4" />
          </Button>
        </div>
      </header>

      <div className="hidden lg:fixed lg:right-4 lg:top-3 lg:z-30 lg:block">
        <ThemeToggle />
      </div>

      <main className="px-4 pb-28 pt-4 lg:ml-60 lg:px-8 lg:pb-12 lg:pt-8">
        <div className="mx-auto w-full max-w-5xl">{children}</div>
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 flex items-center justify-around border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
        {nav.slice(0, 4).map((item) => {
          const active = pathname.startsWith(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              className={cn(
                "relative flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-medium",
                active ? "text-primary" : "text-muted-foreground",
              )}
            >
              <item.icon className="size-5" />
              {item.label}
              {item.to === "/alerts" && !!unread && (
                <span className="absolute right-[22%] top-1.5 size-1.5 rounded-full bg-critical" />
              )}
            </Link>
          );
        })}
        <Link
          to="/radars/new"
          className="flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px] font-medium text-muted-foreground"
        >
          <span className="flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Plus className="size-3.5" />
          </span>
          New
        </Link>
      </nav>
    </div>
  );
}

function NavLink({ item, active, badge }: { item: NavItem; active: boolean; badge?: number | undefined }) {
  return (
    <Link
      to={item.to}
      className={cn(
        "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
        active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
      )}
    >
      <item.icon className="size-4" />
      {item.label}
      {!!badge && (
        <span className="ml-auto rounded-full bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary">
          {badge}
        </span>
      )}
    </Link>
  );
}
