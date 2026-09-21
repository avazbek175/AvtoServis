import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAdmin } from '../../store';
import { Spinner } from '../../components/ui';

export default function ProtectedRoute({ children }) {
  const { user, authLoading } = useAdmin();

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0b0f17]">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }
  if (!user) return <Navigate to="/admin/login" replace />;
  return children;
}