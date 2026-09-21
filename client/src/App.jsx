import { Routes, Route } from 'react-router-dom';
import Home from './pages/Home';
import ServiceDetail from './pages/ServiceDetail';
import AdminLayout from './pages/admin/AdminLayout';
import AdminLogin from './pages/admin/AdminLogin';
import Dashboard from './pages/admin/Dashboard';
import ServicesAdmin from './pages/admin/ServicesAdmin';
import SettingsPage from './pages/admin/SettingsPage';
import SectionPage from './pages/admin/SectionPage';
import UsersAdmin from './pages/admin/UsersAdmin';
import ApplicationsAdmin from './pages/admin/ApplicationsAdmin';
import WorkLogs from './pages/admin/WorkLogs';
import MediaAdmin from './pages/admin/MediaAdmin';
import ProtectedRoute from './pages/admin/ProtectedRoute';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/service/:id" element={<ServiceDetail />} />
      <Route path="/admin/login" element={<AdminLogin />} />
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="services" element={<ServicesAdmin />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="hero" element={<SectionPage section="hero" title="Hero (Bosh sahifa)" />} />
        <Route path="about" element={<SectionPage section="about" title="Biz haqimizda" />} />
        <Route path="contact" element={<SectionPage section="contact" title="Aloqa ma'lumotlari" />} />
        <Route path="footer" element={<SectionPage section="footer" title="Footer sozlamalari" />} />
        <Route path="design" element={<SectionPage section="design" title="Dizayn sozlamalari" />} />
        <Route path="users" element={<UsersAdmin />} />
        <Route path="applications" element={<ApplicationsAdmin />} />
        <Route path="worklogs" element={<WorkLogs />} />
        <Route path="media" element={<MediaAdmin />} />
      </Route>
      <Route path="*" element={<Home />} />
    </Routes>
  );
}