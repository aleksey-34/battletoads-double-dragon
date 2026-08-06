import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Alert, Button, Card, Checkbox, Form, Input, Space, Spin, Typography, message } from 'antd';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useI18n } from '../i18n';
import RiskDisclaimerModal from '../components/RiskDisclaimerModal';
import { RISK_DISCLAIMER_VERSION } from '../content/riskDisclaimer';

type AuthMode = 'login' | 'register';

type ClientAuthProps = {
  initialMode?: AuthMode;
};

type LoginFormValues = {
  email: string;
  password: string;
};

type RegisterFormValues = {
  fullName: string;
  email?: string;
  password: string;
  confirmPassword: string;
  riskDisclaimerAccepted: boolean;
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

const clearClientSessionToken = () => {
  localStorage.removeItem(CLIENT_SESSION_STORAGE_KEY);
  window.dispatchEvent(new Event('auth-changed'));
};

type ExistingClientSession = {
  email: string;
  tenantDisplayName: string;
  productMode: string;
  workspaceRoute: string;
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
  const [existingSession, setExistingSession] = useState<ExistingClientSession | null>(null);
  const [riskDisclaimerOpen, setRiskDisclaimerOpen] = useState(false);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  useEffect(() => {
    const magicToken = String(searchParams.get('token') || '').trim();
    if (magicToken) {
      return;
    }

    const switchAccount = searchParams.get('switch') === '1';
    const token = localStorage.getItem(CLIENT_SESSION_STORAGE_KEY);
    if (!token) {
      setExistingSession(null);
      return;
    }

    let cancelled = false;

    const probeSession = async () => {
      try {
        const response = await axios.get('/api/auth/client/me');
        if (cancelled) {
          return;
        }
        const user = response?.data?.user;
        const workspaceRoute = String(response?.data?.workspaceRoute || '/cabinet');
        setExistingSession({
          email: String(user?.email || ''),
          tenantDisplayName: String(user?.tenantDisplayName || ''),
          productMode: String(user?.productMode || ''),
          workspaceRoute,
        });
        // Already logged in → go to cabinet unless user explicitly wants to switch account.
        if (!switchAccount) {
          navigate(workspaceRoute, { replace: true });
        }
      } catch {
        if (!cancelled) {
          clearClientSessionToken();
          setExistingSession(null);
        }
      }
    };

    void probeSession();

    return () => {
      cancelled = true;
    };
  }, [navigate, searchParams]);

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

  const handleLogoutAndStay = () => {
    clearClientSessionToken();
    setExistingSession(null);
    loginForm.resetFields();
    registerForm.resetFields();
    navigate('/client/login?switch=1', { replace: true });
    messageApi.info(t('client.auth.sessionCleared', 'Session cleared. Sign in with another account.'));
  };

  const handleContinueExistingSession = () => {
    navigate(existingSession?.workspaceRoute || '/cabinet', { replace: true });
  };

  const handleOpenAdminLogin = () => {
    clearClientSessionToken();
    setExistingSession(null);
    navigate('/login');
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
      navigate(String(response?.data?.workspaceRoute || '/cabinet'), { replace: true });
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
        fullName: values.fullName,
        email: String(values.email || '').trim() || undefined,
        password: values.password,
        productMode: 'dual',
        planCode: 'dual_beta',
        preferredLanguage: language,
        showFutures: true,
        showSpot: true,
        riskDisclaimerAccepted: values.riskDisclaimerAccepted === true,
        riskDisclaimerVersion: RISK_DISCLAIMER_VERSION,
      });

      const token = String(response?.data?.token || '');
      if (!token) {
        throw new Error('Session token is missing in registration response');
      }

      saveClientSessionToken(token);
      messageApi.success(t('client.auth.registerSuccess', 'Account created. Welcome to your cabinet.'));
      navigate(String(response?.data?.workspaceRoute || '/cabinet'), { replace: true });
    } catch (error: any) {
      setErrorText(String(error?.response?.data?.error || error?.message || t('client.auth.registerFailed', 'Registration failed')));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="battletoads-form-shell client-auth-shell">
      {contextHolder}
      <div className="client-auth-hero">
        <Typography.Title level={2} className="client-auth-hero__title">
          {t('client.auth.title', 'Client Access')}
        </Typography.Title>
        <div className="client-auth-hero__subtitle">
          {t('client.auth.subtitle', 'Register once, then you always land in your own workspace.')}
        </div>
      </div>
      <Card className="battletoads-card client-auth-card" bordered>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {magicLinkMode === 'idle' && (
            <>
              {existingSession ? (
                <Alert
                  type="info"
                  showIcon
                  message={t('client.auth.existingSessionTitle', 'You are already signed in')}
                  description={(
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      <Typography.Text>
                        {existingSession.email
                          || existingSession.tenantDisplayName
                          || t('client.auth.guestSession', 'Гостевой кабинет')}
                        {existingSession.email && existingSession.tenantDisplayName
                          ? ` · ${existingSession.tenantDisplayName}`
                          : ''}
                      </Typography.Text>
                      <Space wrap>
                        <Button type="primary" size="small" onClick={handleContinueExistingSession}>
                          {t('client.auth.continueToCabinet', 'Continue to my cabinet')}
                        </Button>
                        <Button size="small" onClick={handleLogoutAndStay}>
                          {t('client.auth.signInAnother', 'Sign in as another user')}
                        </Button>
                        <Button size="small" type="link" onClick={handleOpenAdminLogin}>
                          {t('client.auth.adminLogin', 'Admin login')}
                        </Button>
                      </Space>
                    </Space>
                  )}
                />
              ) : (
                <>
              <Space wrap>
                <Button type={mode === 'login' ? 'primary' : 'default'} onClick={() => setMode('login')}>
                  {t('client.auth.loginTab', 'Login')}
                </Button>
                <Button type={mode === 'register' ? 'primary' : 'default'} onClick={() => setMode('register')}>
                  {t('client.auth.registerTab', 'Register')}
                </Button>
                <Button type="link" onClick={handleOpenAdminLogin}>
                  {t('client.auth.adminLogin', 'Admin login')}
                </Button>
                <Button type="link" onClick={() => { window.location.href = '/partner/login'; }}>
                  Кабинет партнёра
                </Button>
              </Space>

              {errorText ? <Alert type="error" showIcon message={errorText} /> : null}

              {mode === 'login' && (
                <Form<LoginFormValues> layout="vertical" form={loginForm} onFinish={handleLogin}>
                  <Form.Item
                    label={t('client.auth.loginId', 'Email или логин кабинета')}
                    name="email"
                    rules={[
                      { required: true, message: t('client.auth.loginIdRequired', 'Укажите email или slug кабинета') },
                    ]}
                  >
                    <Input
                      autoComplete="username"
                      placeholder={t('client.auth.loginIdPlaceholder', 'name@company.com или my-cabinet')}
                    />
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
                  initialValues={{ riskDisclaimerAccepted: false }}
                  onFinish={handleRegister}
                  scrollToFirstError
                >
                  <Form.Item
                    label={t('client.auth.nickName', 'Имя / Ник')}
                    name="fullName"
                    rules={[{ required: true, message: t('client.auth.nickNameRequired', 'Укажите имя или ник') }]}
                  >
                    <Input placeholder={t('client.auth.nickNamePlaceholder', 'Например: Alex')} autoComplete="nickname" />
                  </Form.Item>
                  <Form.Item
                    label={t('client.auth.emailOptional', 'Email (необязательно)')}
                    name="email"
                    rules={[
                      {
                        validator: (_, value) => {
                          const text = String(value || '').trim();
                          if (!text) {
                            return Promise.resolve();
                          }
                          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
                            return Promise.reject(new Error(t('client.auth.emailInvalid', 'Enter valid email')));
                          }
                          return Promise.resolve();
                        },
                      },
                    ]}
                  >
                    <Input
                      type="email"
                      inputMode="email"
                      autoComplete="email"
                      placeholder={t('client.auth.emailOptionalPlaceholder', 'можно не указывать на демо / стриме')}
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
                  <Form.Item
                    name="riskDisclaimerAccepted"
                    valuePropName="checked"
                    rules={[
                      {
                        validator: (_, value) => (
                          value === true
                            ? Promise.resolve()
                            : Promise.reject(new Error(t('client.auth.riskDisclaimerRequired', 'Подтвердите, что вы принимаете уведомление о рисках')))
                        ),
                      },
                    ]}
                  >
                    <Checkbox>
                      {t('client.auth.riskDisclaimerPrefix', 'Я ознакомился(ась) с')}{' '}
                      <Button
                        type="link"
                        style={{ padding: 0, height: 'auto', verticalAlign: 'baseline' }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setRiskDisclaimerOpen(true);
                        }}
                      >
                        {t('client.auth.riskDisclaimerLink', 'Уведомлением о рисках')}
                      </Button>
                      {t('client.auth.riskDisclaimerSuffix', ' и принимаю, что стратегии и ТС не гарантируют прибыль, результат зависит от рынка, а платформа не несёт ответственности за убытки.')}
                    </Checkbox>
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

          {magicLinkMode === 'idle' && !existingSession && (
            <>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                {t('client.auth.helpText', 'After login you are redirected to your own workspace automatically.')}
              </Typography.Paragraph>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                <Button type="link" style={{ padding: 0, height: 'auto' }} onClick={handleOpenAdminLogin}>
                  {t('client.auth.switchToAdmin', 'Need admin dashboard access? Use admin login.')}
                </Button>
                {' · '}
                <Button type="link" style={{ padding: 0, height: 'auto' }} onClick={() => { window.location.href = '/partner/login'; }}>
                  Кабинет партнёра (мониторинг клиентов)
                </Button>
              </Typography.Paragraph>
            </>
          )}
        </Space>
      </Card>
      <RiskDisclaimerModal open={riskDisclaimerOpen} onClose={() => setRiskDisclaimerOpen(false)} />
    </div>
  );
};

export default ClientAuth;
