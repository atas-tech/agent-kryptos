import {
  Activity,
  ArrowLeftRight,
  BadgeDollarSign,
  BarChart3,
  Bot,
  ChevronRight,
  KeyRound,
  LogOut,
  Menu,
  PanelLeftClose,
  ScanSearch,
  Settings,
  ShieldCheck,
  Users
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/useAuth.js";
import type { UserRole } from "../auth/types.js";
import { LocaleSwitcher } from "./LocaleSwitcher.js";

interface NavItem {
  labelKey: string;
  path: string;
  icon: typeof ShieldCheck;
  roles: UserRole[];
}

const NAV_ITEMS: NavItem[] = [
  { labelKey: "nav.dashboard", path: "/", icon: ShieldCheck, roles: ["workspace_admin"] },
  { labelKey: "nav.agents", path: "/agents", icon: Bot, roles: ["workspace_admin", "workspace_operator"] },
  { labelKey: "nav.members", path: "/members", icon: Users, roles: ["workspace_admin"] },
  {
    labelKey: "nav.audit",
    path: "/audit",
    icon: ScanSearch,
    roles: ["workspace_admin", "workspace_operator", "workspace_viewer"]
  },
  {
    labelKey: "nav.offers",
    path: "/public-offers",
    icon: KeyRound,
    roles: ["workspace_admin", "workspace_operator", "workspace_viewer"]
  },
  {
    labelKey: "nav.approvals",
    path: "/approvals",
    icon: ArrowLeftRight,
    roles: ["workspace_admin", "workspace_operator", "workspace_viewer"]
  },
  {
    labelKey: "nav.policy",
    path: "/policy",
    icon: ShieldCheck,
    roles: ["workspace_admin", "workspace_operator"]
  },
  { labelKey: "nav.billing", path: "/billing", icon: BadgeDollarSign, roles: ["workspace_admin"] },
  { labelKey: "nav.analytics", path: "/analytics", icon: BarChart3, roles: ["workspace_admin", "workspace_operator"] },
  { labelKey: "nav.settings", path: "/settings", icon: Settings, roles: ["workspace_admin"] }
];

export function Layout() {
  const { user, workspace, logout } = useAuth();
  const { t } = useTranslation("layout");
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navItems = useMemo(
    () => NAV_ITEMS.filter((item) => (user ? item.roles.includes(user.role) : false)),
    [user]
  );

  async function handleLogout(): Promise<void> {
    await logout();
    navigate("/login", { replace: true });
  }

  return (
    <div className="dashboard-shell">
      <div className="dashboard-mobile-bar">
        <button className="icon-button" onClick={() => setMobileOpen((value) => !value)} type="button">
          {mobileOpen ? <PanelLeftClose size={18} /> : <Menu size={18} />}
        </button>
        <div>
          <div className="workspace-heading">{workspace?.display_name ?? "Workspace"}</div>
          <div className="workspace-meta">{workspace?.slug ?? "secure-ops"}</div>
        </div>
        <div className="status-dot" />
      </div>

      {mobileOpen ? <button className="dashboard-overlay" onClick={() => setMobileOpen(false)} type="button" /> : null}

      <aside className={`dashboard-sidebar ${mobileOpen ? "is-open" : ""}`}>
        <div className="dashboard-sidebar__brand">
          <div className="brand-mark">
            <ShieldCheck size={18} />
          </div>
          <div>
            <div className="workspace-heading">{t("brand.name")}</div>
            <div className="workspace-meta">{workspace?.display_name ?? t("brand.tagline")}</div>
          </div>
        </div>

        <div className="dashboard-sidebar__section">
          <div className="section-label">Workspace</div>
          <div className="workspace-card">
            <div>
              <div className="workspace-card__name">{workspace?.slug ?? "workspace"}</div>
              <div className="workspace-card__tier">{workspace?.tier ?? "free"} tier</div>
            </div>
            <div className="status-pill">live</div>
          </div>
        </div>

        <nav className="dashboard-nav" aria-label="Sidebar">
          {navItems.map((item) => {
            const Icon = item.icon;

            return (
              <NavLink
                key={item.path}
                className={({ isActive }) => `dashboard-nav__link${isActive ? " is-active" : ""}`}
                onClick={() => setMobileOpen(false)}
                to={item.path}
              >
                <span className="dashboard-nav__label">
                  <Icon size={18} />
                  {t(item.labelKey)}
                </span>
                <ChevronRight size={16} />
              </NavLink>
            );
          })}
        </nav>

        <div className="dashboard-sidebar__footer">
          <div className="profile-card">
            <div className="profile-card__avatar">{user?.email.slice(0, 2).toUpperCase() ?? "AK"}</div>
            <div>
              <div className="profile-card__name">{user?.email ?? "operator@example.com"}</div>
              <div className="profile-card__role">{(user?.role ?? "workspace_viewer").replace("workspace_", "")}</div>
            </div>
          </div>
          <LocaleSwitcher />
          <button className="ghost-button" onClick={handleLogout} type="button">
            <LogOut size={16} />
            {t("nav.signOut")}
          </button>
        </div>
      </aside>

      <div className="dashboard-main">
        <header className="dashboard-header">
          <div>
            <div className="section-label">{t("sidebar.operations")}</div>
            <h1 className="dashboard-header__title">
              {t(navItems.find((item) => item.path === location.pathname)?.labelKey ?? "nav.dashboard")}
            </h1>
          </div>

          <div className="dashboard-header__controls">
            <label className="search-field">
              <Activity size={16} />
              <input placeholder="Search workspaces, agents, or audits" type="search" />
            </label>
            <div className="status-pill">session active</div>
          </div>
        </header>

        <main className="dashboard-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
