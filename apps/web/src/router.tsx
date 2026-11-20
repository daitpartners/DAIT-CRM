import { createBrowserRouter } from 'react-router-dom';
import { RequireAuth } from './components/RequireAuth';
import { Dashboard } from './pages/Dashboard';
import { NotFound } from './pages/NotFound';
import { CompaniesPage, LeadsPage, NotificationsPage, ReportsPage, TasksPage } from './pages/Placeholder';

export const router = createBrowserRouter([
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
      { path: '*', element: <NotFound /> },
    ],
  },
]);
