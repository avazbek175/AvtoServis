import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AppProvider } from './store';
import './index.css';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center bg-[#0b0f17] px-6 text-center text-white">
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-8">
            <h1 className="text-xl font-bold">Xatolik yuz berdi</h1>
            <p className="mt-2 text-sm text-white/50">Sahifani qayta yangilab ko'ring.</p>
            <button onClick={() => location.reload()} className="btn-primary mt-5 text-sm">Qayta yuklash</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <AppProvider>
          <App />
        </AppProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);