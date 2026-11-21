import { Navigate, createBrowserRouter, useLocation } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { Dashboard } from './pages/Dashboard';
import { EmailPage } from './pages/email/EmailPage';
import { CampaignPage } from './pages/mailer/CampaignPage';
import { MailerPage } from './pages/mailer/MailerPage';
import { NotFound } from './pages/NotFound';
import { CompaniesList } from './pages/companies/CompaniesList';
import { CompanyProfile } from './pages/companies/CompanyProfile';
import { ContactsList } from './pages/contacts/ContactsList';
import { LeadPage } from './pages/leads/LeadPage';
import { LeadsList } from './pages/leads/LeadsList';
import { NewLeadPage } from './pages/leads/NewLeadPage';
import { NotificationsList } from './pages/notifications/NotificationsList';
import { ReportsPage } from './pages/reports/ReportsPage';
import { SignIn } from './pages/SignIn';
import { TasksList } from './pages/tasks/TasksList';
import { AllocationRules } from './pages/settings/AllocationRules';
import { Connections } from './pages/settings/Connections';
import { EmailTemplates } from './pages/settings/Templates';
import { Lookups } from './pages/settings/Lookups';
import { MySettings } from './pages/settings/MySettings';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { Users } from './pages/settings/Users';

/** The 1A path of the system mailbox (also the Microsoft connect callback's target): kept, query string and all. */
function MailboxRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/settings/connections${search}`} replace />;
}

export const router = createBrowserRouter([
  { path: '/sign-in', element: <SignIn /> },
  {
    path: '/',
    element: <RequireAuth />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'leads', element: <LeadsList /> },
      { path: 'leads/new', element: <NewLeadPage /> },
      { path: 'leads/:id', element: <LeadPage /> },
      { path: 'companies', element: <CompaniesList /> },
      { path: 'companies/:id', element: <CompanyProfile /> },
      { path: 'contacts', element: <ContactsList /> },
      { path: 'email', element: <EmailPage /> },
      { path: 'email/:id', element: <EmailPage /> },
      { path: 'mailer', element: <MailerPage /> },
      { path: 'mailer/:id', element: <CampaignPage /> },
      { path: 'tasks', element: <TasksList /> },
      { path: 'notifications', element: <NotificationsList /> },
      { path: 'reports', element: <ReportsPage /> },
      {
        path: 'settings',
        element: <SettingsLayout />,
        children: [
          { index: true, element: <MySettings /> },
          { path: 'connections', element: <Connections /> },
          { path: 'templates', element: <EmailTemplates /> },
          { path: 'lookups', element: <Lookups /> },
          { path: 'allocation', element: <AllocationRules /> },
          { path: 'users', element: <Users /> },
          { path: 'mailbox', element: <MailboxRedirect /> },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
