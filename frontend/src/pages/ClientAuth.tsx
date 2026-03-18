import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Alert, Button, Card, Form, Input, Select, Space, Typography, message } from 'antd';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n';

type AuthMode = 'login' | 'register';

type ClientAuthProps = {
  initialMode?: AuthMode;
};

type LoginFormValues = {
  email: string;
  password: string;
};

type RegisterFormValues = {
  companyName: string;
  fullName: string;
  email: string;
  password: string;
  confirmPassword: string;
  productMode: 'strategy_client' | 'algofund_client';
};

const CLIENT_SESSION_STORAGE_KEY = 'clientSessionToken';

const saveClientSessionToken = (token: string) => {
  localStorage.setItem(CLIENT_SESSION_STORAGE_KEY, token);
  window.dispatchEvent(new Event('auth-changed'));
};

const ClientAuth: React.FC<ClientAuthProps> = ({ initialMode = 'login' }) => {
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [messageApi, contextHolder] = message.useMessage();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [loginForm] = Form.useForm<LoginFormValues>();
  const [registerForm] = Form.useForm<RegisterFormValues>();

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    const token = String(searchParams.get('token') || '').trim();
    if (!token) {
      return;
    }

    let cancelled = false;

    const consumeMagicToken = async () => {
      setLoading(true);
      setErrorText('');
      try {
        const response = await axios.post('/api/auth/client/magic-login', { token });
        const sessionToken = String(response?.data?.token || '');
        if (!sessionToken) {
          throw new Error('Session token is missing in magic login response');
        }
        if (cancelled) {
          return;
        }
        saveClientSessionToken(sessionToken);
        messageApi.success(t('client.auth.magicSuccess', 'One-time login successful'));
        navigate('/cabinet', { replace: true });
      } catch (error: any) {
        if (!cancelled) {
          setErrorText(String(error?.response?.data?.error || error?.message || t('client.auth.magicFailed', 'Magic login failed')));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void consumeMagicToken();

    return () => {
      cancelled = true;
    };
  }, [messageApi, navigate, searchParams, t]);

  const handleLogin = async (values: LoginFormValues) => {
    setLoading(true);
    setErrorText('');

    try {
      const response = await axios.post('/api/auth/client/login', {
        email: values.email,
        password: values.password,
      });

      const token = String(response?.data?.token || '');
      if (!token) {
        throw new Error('Session token is missing in login response');
      }

      saveClientSessionToken(token);
      messageApi.success(t('client.auth.loginSuccess', 'Client login successful'));
      navigate('/cabinet');
    } catch (error: any) {
      setErrorText(String(error?.response?.data?.error || error?.message || t('client.auth.loginFailed', 'Login failed')));
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (values: RegisterFormValues) => {
    setLoading(true);
    setErrorText('');

    try {
      const response = await axios.post('/api/auth/client/register', {
        companyName: values.companyName,
        fullName: values.fullName,
        email: values.email,
        password: values.password,
        productMode: values.productMode,
        preferredLanguage: language,
      });

      const token = String(response?.data?.token || '');
      if (!token) {
        throw new Error('Session token is missing in registration response');
      }

      saveClientSessionToken(token);
      messageApi.success(t('client.auth.registerSuccess', 'Account created. Welcome to your cabinet.'));
      navigate('/cabinet');
    } catch (error: any) {
      setErrorText(String(error?.response?.data?.error || error?.message || t('client.auth.registerFailed', 'Registration failed')));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="battletoads-form-shell client-auth-shell">
      {contextHolder}
      <Card className="battletoads-card client-auth-card" bordered>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Typography.Title level={3} style={{ marginBottom: 4 }}>
              {t('client.auth.title', 'Client Access')}
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {t('client.auth.subtitle', 'Register once, then you always land in your own workspace.')}
            </Typography.Paragraph>
          </div>

          <Space wrap>
            <Button type={mode === 'login' ? 'primary' : 'default'} onClick={() => setMode('login')}>
              {t('client.auth.loginTab', 'Login')}
            </Button>
            <Button type={mode === 'register' ? 'primary' : 'default'} onClick={() => setMode('register')}>
              {t('client.auth.registerTab', 'Register')}
            </Button>
            <Button type="link" href="/login">
              {t('client.auth.adminLogin', 'Admin login')}
            </Button>
          </Space>

          {errorText ? <Alert type="error" showIcon message={errorText} /> : null}

          {mode === 'login' ? (
            <Form<LoginFormValues> layout="vertical" form={loginForm} onFinish={handleLogin}>
              <Form.Item
                label={t('client.auth.email', 'Email')}
                name="email"
                rules={[
                  { required: true, message: t('client.auth.emailRequired', 'Email is required') },
                  { type: 'email', message: t('client.auth.emailInvalid', 'Enter valid email') },
                ]}
              >
                <Input type="email" inputMode="email" autoComplete="email" placeholder="name@company.com" />
              </Form.Item>
              <Form.Item
                label={t('client.auth.password', 'Password')}
                name="password"
                rules={[{ required: true, message: t('client.auth.passwordRequired', 'Password is required') }]}
              >
                <Input.Password autoComplete="current-password" placeholder={t('client.auth.password', 'Password')} />
              </Form.Item>
              <Form.Item style={{ marginBottom: 0 }}>
                <Button type="primary" htmlType="submit" loading={loading} block>
                  {t('client.auth.loginAction', 'Open my cabinet')}
                </Button>
              </Form.Item>
            </Form>
          ) : (
            <Form<RegisterFormValues>
              layout="vertical"
              form={registerForm}
              initialValues={{ productMode: 'strategy_client' }}
              onFinish={handleRegister}
            >
              <Form.Item
                label={t('client.auth.companyName', 'Company or workspace name')}
                name="companyName"
                rules={[{ required: true, message: t('client.auth.companyNameRequired', 'Company/workspace name is required') }]}
              >
                <Input placeholder={t('client.auth.companyNamePlaceholder', 'Acme Trading Desk')} />
              </Form.Item>
              <Form.Item
                label={t('client.auth.fullName', 'Full name')}
                name="fullName"
                rules={[{ required: true, message: t('client.auth.fullNameRequired', 'Full name is required') }]}
              >
                <Input placeholder={t('client.auth.fullNamePlaceholder', 'John Smith')} />
              </Form.Item>
              <Form.Item
                label={t('client.auth.email', 'Email')}
                name="email"
                rules={[
                  { required: true, message: t('client.auth.emailRequired', 'Email is required') },
                  { type: 'email', message: t('client.auth.emailInvalid', 'Enter valid email') },
                ]}
              >
                <Input type="email" inputMode="email" autoComplete="email" placeholder="name@company.com" />
              </Form.Item>
              <Form.Item
                label={t('client.auth.productMode', 'Workspace type')}
                name="productMode"
                rules={[{ required: true, message: t('client.auth.productModeRequired', 'Choose workspace type') }]}
              >
                <Select
                  options={[
                    { value: 'strategy_client', label: t('client.auth.productModeStrategy', 'Strategy Client') },
                    { value: 'algofund_client', label: t('client.auth.productModeAlgofund', 'Algofund Client') },
                  ]}
                />
              </Form.Item>
              <Form.Item
                label={t('client.auth.password', 'Password')}
                name="password"
                rules={[
                  { required: true, message: t('client.auth.passwordRequired', 'Password is required') },
                  { min: 10, message: t('client.auth.passwordMin', 'Password must be at least 10 characters') },
                ]}
              >
                <Input.Password autoComplete="new-password" placeholder={t('client.auth.passwordPlaceholder', 'Strong password (10+ chars)')} />
              </Form.Item>
              <Form.Item
                label={t('client.auth.confirmPassword', 'Confirm password')}
                name="confirmPassword"
                dependencies={['password']}
                rules={[
                  { required: true, message: t('client.auth.confirmPasswordRequired', 'Confirm your password') },
                  ({ getFieldValue }) => ({
                    validator(_, value) {
                      if (!value || getFieldValue('password') === value) {
                        return Promise.resolve();
                      }
                      return Promise.reject(new Error(t('client.auth.confirmPasswordMismatch', 'Passwords do not match')));
                    },
                  }),
                ]}
              >
                <Input.Password autoComplete="new-password" placeholder={t('client.auth.confirmPasswordPlaceholder', 'Repeat your password')} />
              </Form.Item>
              <Form.Item style={{ marginBottom: 0 }}>
                <Button type="primary" htmlType="submit" loading={loading} block>
                  {t('client.auth.registerAction', 'Create account and open cabinet')}
                </Button>
              </Form.Item>
            </Form>
          )}

          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            {t('client.auth.helpText', 'After login you are redirected to your own workspace automatically.')}
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            <Link to="/login">{t('client.auth.switchToAdmin', 'Need admin dashboard access? Use admin login.')}</Link>
          </Typography.Paragraph>
        </Space>
      </Card>
    </div>
  );
};

export default ClientAuth;
