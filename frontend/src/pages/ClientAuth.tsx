import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Alert, Button, Card, Form, Input, Select, Space, Spin, Typography, message } from 'antd';
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

type SetPasswordFormValues = {
  password: string;
  confirmPassword: string;
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
  const [setPasswordForm] = Form.useForm<SetPasswordFormValues>();
  const [magicLinkMode, setMagicLinkMode] = useState<'idle' | 'processing' | 'password_setup' | 'success'>('idle');
  const [magicLinkEmail, setMagicLinkEmail] = useState<string>('');

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
      setMagicLinkMode('processing');
      setErrorText('');
      try {
        const response = await axios.post('/api/auth/client/magic-login', { token });
        const sessionToken = String(response?.data?.token || '');
        const email = String(response?.data?.email || '');
        if (!sessionToken) {
          throw new Error('Session token is missing in magic login response');
        }
        if (cancelled) {
          return;
        }
        saveClientSessionToken(sessionToken);
        setMagicLinkEmail(email);
        setMagicLinkMode('password_setup');
        messageApi.success(t('client.auth.magicSuccess', 'One-time login successful'));
      } catch (error: any) {
        if (!cancelled) {
          setErrorText(String(error?.response?.data?.error || error?.message || t('client.auth.magicFailed', 'Magic login failed')));
          setMagicLinkMode('idle');
        }
      }
    };

    void consumeMagicToken();

    return () => {
      cancelled = true;
    };
  }, [messageApi, searchParams, t]);

  const handleSetPassword = async (values: SetPasswordFormValues) => {
    if (values.password !== values.confirmPassword) {
      setErrorText(t('client.auth.passwordMismatch', 'Passwords do not match'));
      return;
    }

    setLoading(true);
    setErrorText('');

    try {
      await axios.post('/api/auth/client/set-password', {
        newPassword: values.password,
      });

      setMagicLinkMode('success');
      messageApi.success(t('client.auth.passwordSetSuccess', 'Password set successfully'));
      setTimeout(() => {
        navigate('/cabinet', { replace: true });
      }, 1000);
    } catch (error: any) {
      setErrorText(String(error?.response?.data?.error || error?.message || t('client.auth.passwordSetFailed', 'Failed to set password')));
    } finally {
      setLoading(false);
    }
  };

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

          {magicLinkMode === 'idle' && (
            <>
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

              {mode === 'login' && (
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
              )}

              {mode === 'register' && (
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
            </>
          )}

          {magicLinkMode === 'processing' && (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <Spin size="large" />
              <Typography.Paragraph style={{ marginTop: 16 }}>
                {t('client.auth.processingMagicLink', 'Processing your login link...')}
              </Typography.Paragraph>
            </div>
          )}

          {magicLinkMode === 'password_setup' && (
            <>
              {errorText ? <Alert type="error" showIcon message={errorText} style={{ marginBottom: 12 }} /> : null}
              <Form<SetPasswordFormValues>
                layout="vertical"
                form={setPasswordForm}
                onFinish={handleSetPassword}
              >
                <Typography.Title level={5} style={{ marginBottom: 12 }}>
                  {t('client.auth.setPasswordTitle', 'Set Your Password')}
                </Typography.Title>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                  {t('client.auth.setPasswordSubtitle', `You've successfully logged in. Now set a password for your account (${magicLinkEmail}).`)}
                </Typography.Paragraph>
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
                    {t('client.auth.setPasswordAction', 'Confirm and enter my cabinet')}
                  </Button>
                </Form.Item>
              </Form>
            </>
          )}

          {magicLinkMode === 'success' && (
            <div style={{ textAlign: 'center', padding: '40px 20px' }}>
              <Typography.Title level={5} style={{ marginBottom: 8 }}>
                {t('client.auth.passwordSetSuccess', 'Password set successfully')}
              </Typography.Title>
              <Typography.Paragraph type="secondary">
                {t('client.auth.redirectingToCabinet', 'Redirecting to your cabinet...')}
              </Typography.Paragraph>
            </div>
          )}

          {magicLinkMode === 'idle' && (
            <>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {t('client.auth.helpText', 'After login you are redirected to your own workspace automatically.')}
              </Typography.Paragraph>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                <Link to="/login">{t('client.auth.switchToAdmin', 'Need admin dashboard access? Use admin login.')}</Link>
              </Typography.Paragraph>
            </>
          )}
        </Space>
      </Card>
    </div>
  );
};

export default ClientAuth;
