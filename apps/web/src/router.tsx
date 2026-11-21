import { createBrowserRouter } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { Dashboard } from './pages/Dashboard';
import { NotFound } from './pages/NotFound';
import { CompaniesList } from './pages/companies/CompaniesList';
import { CompanyProfile } from './pages/companies/CompanyProfile';
import { ContactsList } from './pages/contacts/ContactsList';
import { LeadPage } from './pages/leads/LeadPage';
import { LeadsList } from './pages/leads/LeadsList';
import { NotificationsList } from './pages/notifications/NotificationsList';
import { ReportsPage } from './pages/Placeholder';
import { SignIn } from './pages/SignIn';
import { TasksList } from './pages/tasks/TasksList';
import { AllocationRules } from './pages/settings/AllocationRules';
import { Lookups } from './pages/settings/Lookups';
import { MySettings } from './pages/settings/MySettings';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { SystemMailbox } from './pages/settings/SystemMailbox';
import { Users } from './pages/settings/Users';

export const router = createBrowserRouter([
  { path: '/sign-in', element: <SignIn /> },
  {
    path: '/',
    element: <RequireAuth />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'leads', element: <LeadsList /> },
      { path: 'leads/:id', element: <LeadPage /> },
      { path: 'companies', element: <CompaniesList /> },
      { path: 'companies/:id', element: <CompanyProfile /> },
      { path: 'contacts', element: <ContactsList /> },
      { path: 'tasks', element: <TasksList /> },
      { path: 'notifications', element: <NotificationsList /> },
      { path: 'reports', element: <ReportsPage /> },
      {
        path: 'settings',
        element: <SettingsLayout />,
        children: [
          { index: true, element: <MySettings /> },
          { path: 'users', element: <Users /> },
          { path: 'lookups', element: <Lookups /> },
          { path: 'allocation', element: <AllocationRules /> },
          { path: 'mailbox', element: <SystemMailbox /> },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
