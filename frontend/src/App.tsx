import React from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import { Layout, Menu } from 'antd';
import Dashboard from './pages/Dashboard';
import Settings from './pages/Settings';
import Positions from './pages/Positions';
import Login from './pages/Login';
import Logs from './pages/Logs';
import './App.css';

const { Header, Content } = Layout;

function App() {
  const menuItems = [
    { key: '1', label: <Link to="/">Dashboard</Link> },
    { key: '2', label: <Link to="/settings">Settings</Link> },
    { key: '3', label: <Link to="/positions">Positions</Link> },
    { key: '4', label: <Link to="/logs">Logs</Link> },
  ];

  return (
    <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Layout style={{ minHeight: '100vh' }}>
        <Header style={{ color: 'white' }}>
          <Menu theme="dark" mode="horizontal" defaultSelectedKeys={['1']} items={menuItems} />
        </Header>
        <Content style={{ padding: '20px' }}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Dashboard />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/positions" element={<Positions />} />
            <Route path="/logs" element={<Logs />} />
          </Routes>
        </Content>
      </Layout>
    </Router>
  );
}

export default App;