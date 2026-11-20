import { createBrowserRouter } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { Dashboard } from './pages/Dashboard';
import { NotFound } from './pages/NotFound';
import { CompaniesPage, LeadsPage, NotificationsPage, ReportsPage, TasksPage } from './pages/Placeholder';
import { SignIn } from './pages/SignIn';
import { AllocationRules } from './pages/settings/AllocationRules';
import { Lookups } from './pages/settings/Lookups';
import { MySettings } from './pages/settings/MySettings';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { Users } from './pages/settings/Users';

export const router = createBrowserRouter([
  { path: '/sign-in', element: <SignIn /> },
  {
    path: '/',
    element: <RequireAuth />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'leads', element: <LeadsPage /> },
      { path: 'companies', element: <CompaniesPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'notifications', element: <NotificationsPage /> },
      { path: 'reports', element: <ReportsPage /> },
      {
        path: 'settings',
        element: <SettingsLayout />,
        children: [
          { index: true, element: <MySettings /> },
          { path: 'users', element: <Users /> },
          { path: 'lookups', element: <Lookups /> },
          { path: 'allocation', element: <AllocationRules /> },
          // Task 8: { path: 'mailbox', element: <SystemMailbox /> }
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
