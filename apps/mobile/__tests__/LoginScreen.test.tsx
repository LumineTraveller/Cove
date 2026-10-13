import TestRenderer, { act } from 'react-test-renderer';
import {
  Alert,
  NativeModules,
  Platform,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
} from 'react-native';
import { LoginScreen } from '../src/features/accounts/screens/LoginScreen';
import {
  captureAccountPasswordSaveIntent,
  invalidateAccountPasswordSaves,
  saveAuthenticatedAccountPassword,
  type PasswordMemoryResult,
} from '../src/features/accounts/accountPasswordMemory';

jest.mock('lucide-react-native', () => ({
  LockKeyhole: 'LockKeyhole',
  LogIn: 'LogIn',
  Mail: 'Mail',
  Server: 'Server',
  UserRound: 'UserRound',
  Moon: 'Moon',
  Sun: 'Sun',
}));

const enabledSecurity = {
  enabled: true,
  configured: true,
  bootstrapAvailable: false,
  tokenEpoch: 1,
  authorized: false,
  secureTransportRequired: false,
};
const disabledSecurity = {
  ...enabledSecurity,
  enabled: false,
  configured: false,
  tokenEpoch: 0,
};

const passwordNative = {
  status: jest.fn(),
  get: jest.fn(),
  save: jest.fn(),
  remove: jest.fn(),
  clear: jest.fn(),
  list: jest.fn(),
};
beforeEach(() => {
  jest.useFakeTimers();
  invalidateAccountPasswordSaves();
  Platform.OS = 'android';
  NativeModules.CoveAccountPasswords = passwordNative;
  for (const method of Object.values(passwordNative)) method.mockReset();
  passwordNative.status.mockResolvedValue({ available: true, ok: true });
  passwordNative.get.mockResolvedValue({
    available: true,
    ok: true,
    remembered: false,
    password: null,
  });
  passwordNative.save.mockResolvedValue({
    available: true,
    ok: true,
    remembered: true,
  });
  passwordNative.remove.mockResolvedValue({
    available: true,
    ok: true,
    remembered: false,
  });
  passwordNative.clear.mockResolvedValue({
    available: true,
    ok: true,
    remembered: false,
  });
  passwordNative.list.mockResolvedValue({
    available: true,
    ok: true,
    accounts: [],
  });
});
afterEach(() => {
  delete NativeModules.CoveAccountPasswords;
  jest.restoreAllMocks();
  jest.useRealTimers();
});

async function finishProbe() {
  await act(async () => {
    jest.advanceTimersByTime(350);
    await Promise.resolve();
  });
}

test('certificate switch is opt-in, resets on endpoint change, and does not apply to HTTP', async () => {
  Platform.OS = 'android';
  const submit = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <LoginScreen
        saving={false}
        onSubmit={submit}
        onProbeServerSecurity={async () => enabledSecurity}
      />,
    );
  });
  const inputs = () => renderer.root.findAllByType(TextInput);
  const serverInput = () =>
    inputs().find(item => item.props.keyboardType === 'url')!;
  await act(async () =>
    serverInput().props.onChangeText('https://host.test:51758'),
  );
  await finishProbe();
  await act(async () =>
    inputs()
      .find(item => item.props.keyboardType === 'email-address')!
      .props.onChangeText('alice@example.com'),
  );
  await act(async () =>
    inputs()
      .find(item => item.props.secureTextEntry)!
      .props.onChangeText('password'),
  );
  expect(renderer.root.findByType(Switch).props.value).toBe(false);
  await act(async () =>
    renderer.root.findByType(Switch).props.onValueChange(true),
  );
  await finishProbe();
  await act(async () =>
    inputs()
      .filter(item => item.props.secureTextEntry)[1]!
      .props.onChangeText('server-password'),
  );
  const submitButton = () =>
    renderer.root.findAllByType(TouchableOpacity).at(-1)!;
  await act(async () => submitButton().props.onPress());
  expect(submit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      mode: 'login',
      email: 'alice@example.com',
      password: 'password',
      serverPassword: 'server-password',
      bootstrapToken: '',
      serverURL: 'https://host.test:51758',
      allowInvalidServerCertificate: true,
    }),
  );
  await act(async () =>
    serverInput().props.onChangeText('https://host.test:51759'),
  );
  expect(renderer.root.findByType(Switch).props.value).toBe(false);
  await finishProbe();
  await act(async () =>
    serverInput().props.onChangeText('http://host.test:51758'),
  );
  await finishProbe();
  expect(renderer.root.findAllByType(Switch)).toHaveLength(0);
  await act(async () => submitButton().props.onPress());
  expect(submit).toHaveBeenLastCalledWith(
    expect.objectContaining({
      serverURL: 'http://host.test:51758',
      allowInvalidServerCertificate: false,
    }),
  );
  await act(async () => renderer.unmount());
}, 20_000);

test('saved enabled server prefills address/email but still requires the server password', async () => {
  const saved = {
    username: 'Alice',
    serverURL: 'https://one.test',
    email: 'alice@test.com',
    clientId: 'device',
    accountId: 'account',
    accountToken: 'saved-token',
  };
  const forget = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <LoginScreen
        saving={false}
        onSubmit={jest.fn()}
        rememberedServers={[saved]}
        onForget={forget}
        onProbeServerSecurity={async () => enabledSecurity}
      />,
    );
  });
  await finishProbe();
  const inputs = renderer.root.findAllByType(TextInput);
  expect(
    inputs.find(input => input.props.keyboardType === 'url')!.props.value,
  ).toBe(saved.serverURL);
  expect(
    inputs.find(input => input.props.keyboardType === 'email-address')!.props
      .value,
  ).toBe(saved.email);
  expect(inputs.find(input => input.props.secureTextEntry)!.props.value).toBe(
    '',
  );
  await act(async () =>
    renderer.root
      .findByProps({ accessibilityLabel: `填写并连接 ${saved.serverURL}` })
      .props.onPress(),
  );
  expect(
    renderer.root
      .findAllByType(TextInput)
      .filter(input => input.props.secureTextEntry)[1]!.props.value,
  ).toBe('');
  await act(async () =>
    renderer.root
      .findByProps({ accessibilityLabel: `忘记 ${saved.serverURL}` })
      .props.onPress(),
  );
  expect(forget).toHaveBeenCalledWith(saved);
  await act(async () => renderer.unmount());
});

test('disabled server keeps the legacy login form and does not require a server password', async () => {
  const submit = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <LoginScreen
        saving={false}
        onSubmit={submit}
        onProbeServerSecurity={async () => disabledSecurity}
      />,
    );
  });
  const inputs = () => renderer.root.findAllByType(TextInput);
  await act(async () =>
    inputs()
      .find(input => input.props.keyboardType === 'url')!
      .props.onChangeText('https://legacy.test'),
  );
  await finishProbe();
  await act(async () =>
    inputs()
      .find(input => input.props.keyboardType === 'email-address')!
      .props.onChangeText('legacy@example.com'),
  );
  await act(async () =>
    inputs()
      .find(input => input.props.secureTextEntry)!
      .props.onChangeText('password-123'),
  );
  expect(inputs().filter(input => input.props.secureTextEntry)).toHaveLength(1);
  const submitButton = renderer.root.findAllByType(TouchableOpacity).at(-1)!;
  expect(submitButton.props.disabled).toBe(false);
  await act(async () => submitButton.props.onPress());
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      serverURL: 'https://legacy.test',
      serverPassword: '',
      bootstrapToken: '',
    }),
  );
  await act(async () => renderer.unmount());
});

test('uninitialized server requires an available bootstrap credential before submit', async () => {
  const unavailable = {
    ...enabledSecurity,
    configured: false,
    bootstrapAvailable: false,
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <LoginScreen
        saving={false}
        onSubmit={jest.fn()}
        onProbeServerSecurity={async () => unavailable}
      />,
    );
  });
  const inputs = () => renderer.root.findAllByType(TextInput);
  await act(async () =>
    inputs()
      .find(input => input.props.keyboardType === 'url')!
      .props.onChangeText('https://new.test'),
  );
  await finishProbe();
  expect(inputs().some(input => input.props.placeholder === '一次性凭据')).toBe(
    false,
  );
  expect(
    renderer.root.findAllByType(TouchableOpacity).at(-1)!.props.disabled,
  ).toBe(true);
  expect(
    renderer.root
      .findAllByType(Text)
      .some(item =>
        String(item.props.children).includes('尚未配置一次性初始化凭据'),
      ),
  ).toBe(true);
  await act(async () => renderer.unmount());
});

const savedAccount = (
  serverURL = 'https://one.test',
  email = 'alice@test.com',
) => ({
  username: 'Synthetic account',
  serverURL,
  email,
  clientId: 'synthetic-device',
  accountId: 'synthetic-account',
});
const accountPassword = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root
    .findAllByType(TextInput)
    .find(input => input.props.secureTextEntry)!;
const emailInput = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root
    .findAllByType(TextInput)
    .find(input => input.props.keyboardType === 'email-address')!;
const addressInput = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root
    .findAllByType(TextInput)
    .find(input => input.props.keyboardType === 'url')!;
const memoryToggle = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findByProps({ accessibilityLabel: '记住账号密码' });
const modeTabs = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root
    .findAllByType(TouchableOpacity)
    .filter(item => item.props.accessibilityRole === 'tab');

test('a remembered account safely fills its account password, while server access remains manual', async () => {
  const saved = savedAccount();
  const submit = jest.fn();
  passwordNative.get.mockResolvedValue({
    available: true,
    ok: true,
    remembered: true,
    password: 'synthetic-remembered-password',
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <LoginScreen
        saving={false}
        onSubmit={submit}
        rememberedServers={[saved]}
        onProbeServerSecurity={async () => enabledSecurity}
      />,
    );
  });
  await finishProbe();
  expect(accountPassword(renderer).props.value).toBe(
    'synthetic-remembered-password',
  );
  expect(memoryToggle(renderer).props.accessibilityState.checked).toBe(true);
  expect(
    renderer.root
      .findAllByType(TextInput)
      .filter(input => input.props.secureTextEntry)[1]!.props.value,
  ).toBe('');
  await act(async () =>
    renderer.root
      .findAllByType(TextInput)
      .filter(input => input.props.secureTextEntry)[1]!
      .props.onChangeText('synthetic-server-password'),
  );
  await act(async () =>
    renderer.root.findAllByType(TouchableOpacity).at(-1)!.props.onPress(),
  );
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      rememberAccountPassword: true,
      password: 'synthetic-remembered-password',
      serverPassword: 'synthetic-server-password',
    }),
  );
  await act(async () => renderer.unmount());
});

test.each(['password', 'email', 'address', 'mode', 'clear', 'off'] as const)(
  '%s edits cancel a late saved-password read',
  async action => {
    const saved = savedAccount();
    let release!: (value: PasswordMemoryResult) => void;
    passwordNative.get.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LoginScreen
          saving={false}
          onSubmit={jest.fn()}
          rememberedServers={[saved]}
          onProbeServerSecurity={async () => disabledSecurity}
        />,
      );
    });
    await act(async () => {
      if (action === 'password')
        accountPassword(renderer).props.onChangeText(
          'synthetic-manual-password',
        );
      if (action === 'email')
        emailInput(renderer).props.onChangeText('other@test.com');
      if (action === 'address')
        addressInput(renderer).props.onChangeText('https://two.test');
      if (action === 'mode') modeTabs(renderer)[1]!.props.onPress();
      if (action === 'clear')
        renderer.root
          .findByProps({ accessibilityLabel: '清除已记住的账号密码' })
          .props.onPress();
      if (action === 'off') {
        memoryToggle(renderer).props.onPress();
      }
    });
    if (action === 'off')
      await act(async () => memoryToggle(renderer).props.onPress());
    await act(async () =>
      release({
        available: true,
        ok: true,
        remembered: true,
        password: 'synthetic-late-password',
      }),
    );
    expect(accountPassword(renderer).props.value).toBe(
      action === 'password' ? 'synthetic-manual-password' : '',
    );
    expect(memoryToggle(renderer).props.accessibilityState.checked).toBe(false);
    if (action === 'off')
      expect(passwordNative.remove).toHaveBeenCalledWith(
        saved.serverURL,
        saved.email,
      );
    if (action === 'clear')
      expect(passwordNative.clear).toHaveBeenCalledTimes(1);
    await act(async () => renderer.unmount());
  },
);

test('switching historical accounts ignores the earlier credential result', async () => {
  const first = savedAccount();
  const second = savedAccount('https://two.test', 'bob@test.com');
  let release!: (value: PasswordMemoryResult) => void;
  passwordNative.get
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    )
    .mockResolvedValueOnce({
      available: true,
      ok: true,
      remembered: true,
      password: 'synthetic-bob-password',
    });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <LoginScreen
        saving={false}
        onSubmit={jest.fn()}
        rememberedServers={[first, second]}
        onProbeServerSecurity={async () => disabledSecurity}
      />,
    );
  });
  await act(async () =>
    renderer.root
      .findByProps({ accessibilityLabel: `填写并连接 ${second.serverURL}` })
      .props.onPress(),
  );
  await act(async () =>
    release({
      available: true,
      ok: true,
      remembered: true,
      password: 'synthetic-alice-password',
    }),
  );
  expect(accountPassword(renderer).props.value).toBe('synthetic-bob-password');
  expect(emailInput(renderer).props.value).toBe(second.email);
  await act(async () => renderer.unmount());
});

test('native metadata supplies a second account on the same server without replacing server history', async () => {
  const saved = savedAccount();
  const other = { serverURL: saved.serverURL, email: 'other@test.com' };
  passwordNative.list.mockResolvedValue({
    available: true,
    ok: true,
    accounts: [saved, other],
  });
  passwordNative.get.mockImplementation(async (_address, email) => ({
    available: true,
    ok: true,
    remembered: true,
    password:
      email === other.email
        ? 'synthetic-other-password'
        : 'synthetic-alice-password',
  }));
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <LoginScreen
        saving={false}
        onSubmit={jest.fn()}
        rememberedServers={[saved]}
        onProbeServerSecurity={async () => disabledSecurity}
      />,
    );
  });
  expect(
    renderer.root.findByProps({
      accessibilityLabel: `填写并连接 ${saved.serverURL}`,
    }),
  ).toBeDefined();
  await act(async () =>
    renderer.root
      .findByProps({
        accessibilityLabel: `填写已记住账号 ${other.serverURL} ${other.email}`,
      })
      .props.onPress(),
  );
  expect(accountPassword(renderer).props.value).toBe(
    'synthetic-other-password',
  );
  await act(async () =>
    renderer.root
      .findByProps({
        accessibilityLabel: `取消记忆 ${other.serverURL} ${other.email}`,
      })
      .props.onPress(),
  );
  expect(passwordNative.remove).toHaveBeenCalledWith(
    other.serverURL,
    other.email,
  );
  expect(accountPassword(renderer).props.value).toBe('');
  expect(
    renderer.root.findByProps({
      accessibilityLabel: `填写并连接 ${saved.serverURL}`,
    }),
  ).toBeDefined();
  await act(async () => renderer.unmount());
});

test('saving locks scope edits but permits immediate memory cancellation and revokes a pending login save', async () => {
  const saved = savedAccount();
  const props = {
    onSubmit: jest.fn(),
    rememberedServers: [saved],
    onProbeServerSecurity: async () => disabledSecurity,
  };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LoginScreen {...props} saving={false} />);
  });
  await act(async () => memoryToggle(renderer).props.onPress());
  const intent = captureAccountPasswordSaveIntent(saved.serverURL, saved.email);
  await act(async () => renderer.update(<LoginScreen {...props} saving />));
  expect(addressInput(renderer).props.editable).toBe(false);
  expect(emailInput(renderer).props.editable).toBe(false);
  expect(accountPassword(renderer).props.editable).toBe(false);
  expect(modeTabs(renderer).every(tab => tab.props.disabled)).toBe(true);
  expect(memoryToggle(renderer).props.disabled).toBe(false);
  await act(async () => memoryToggle(renderer).props.onPress());
  expect(passwordNative.remove).toHaveBeenCalledWith(
    saved.serverURL,
    saved.email,
  );
  expect(
    (
      await saveAuthenticatedAccountPassword(
        saved.serverURL,
        saved.email,
        'synthetic-request-password',
        true,
        intent,
      )
    ).cancelled,
  ).toBe(true);
  expect(passwordNative.save).not.toHaveBeenCalled();
  await act(async () => renderer.unmount());
});

test('unmount cancels credential restoration and an unfinished login intent', async () => {
  const saved = savedAccount();
  let release!: (value: PasswordMemoryResult) => void;
  passwordNative.get.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <LoginScreen
        saving={false}
        onSubmit={jest.fn()}
        rememberedServers={[saved]}
        onProbeServerSecurity={async () => disabledSecurity}
      />,
    );
  });
  const intent = captureAccountPasswordSaveIntent(saved.serverURL, saved.email);
  await act(async () => renderer.unmount());
  await act(async () =>
    release({
      available: true,
      ok: true,
      remembered: true,
      password: 'synthetic-late-password',
    }),
  );
  expect(
    (
      await saveAuthenticatedAccountPassword(
        saved.serverURL,
        saved.email,
        'synthetic-request-password',
        true,
        intent,
      )
    ).cancelled,
  ).toBe(true);
  expect(passwordNative.save).not.toHaveBeenCalled();
});

test('unavailable secure storage permits manual login and disables opt-in', async () => {
  delete NativeModules.CoveAccountPasswords;
  let renderer!: TestRenderer.ReactTestRenderer;
  const submit = jest.fn();
  await act(async () => {
    renderer = TestRenderer.create(
      <LoginScreen
        saving={false}
        onSubmit={submit}
        rememberedServers={[savedAccount()]}
        onProbeServerSecurity={async () => disabledSecurity}
      />,
    );
  });
  await finishProbe();
  expect(memoryToggle(renderer).props.disabled).toBe(true);
  await act(async () =>
    accountPassword(renderer).props.onChangeText('synthetic-manual-password'),
  );
  const button = renderer.root.findAllByType(TouchableOpacity).at(-1)!;
  expect(button.props.disabled).toBe(false);
  await act(async () => button.props.onPress());
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ rememberAccountPassword: false }),
  );
  await act(async () => renderer.unmount());
});

test('last-server restoration takes priority and only matches that server account', async () => {
  const first = savedAccount();
  const second = savedAccount('https://two.test', 'bob@test.com');
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <LoginScreen
        saving={false}
        onSubmit={jest.fn()}
        rememberedServers={[first, second]}
        lastServerURL={second.serverURL}
        onProbeServerSecurity={async () => disabledSecurity}
      />,
    );
  });
  expect(addressInput(renderer).props.value).toBe(second.serverURL);
  expect(emailInput(renderer).props.value).toBe(second.email);
  expect(passwordNative.get).toHaveBeenCalledWith(
    second.serverURL,
    second.email,
  );
  await act(async () =>
    renderer.update(
      <LoginScreen
        saving={false}
        onSubmit={jest.fn()}
        rememberedServers={[first, second]}
        lastServerURL="https://new.test"
        onProbeServerSecurity={async () => disabledSecurity}
      />,
    ),
  );
  expect(addressInput(renderer).props.value).toBe('https://new.test');
  expect(emailInput(renderer).props.value).toBe('');
  await act(async () => renderer.unmount());
});

test.each(['', 'https://manual.test'])(
  'a manual address edit to %s survives delayed persisted-address/history arrival',
  async value => {
    const onServerURLChange = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    const props = {
      saving: false,
      onSubmit: jest.fn(),
      onServerURLChange,
      onProbeServerSecurity: async () => disabledSecurity,
    };
    await act(async () => {
      renderer = TestRenderer.create(<LoginScreen {...props} />);
    });
    await act(async () => addressInput(renderer).props.onChangeText(value));
    await act(async () =>
      renderer.update(
        <LoginScreen
          {...props}
          rememberedServers={[savedAccount()]}
          lastServerURL="https://restored.test"
        />,
      ),
    );
    expect(addressInput(renderer).props.value).toBe(value);
    expect(emailInput(renderer).props.value).toBe('');
    expect(onServerURLChange).toHaveBeenCalledWith(value);
    await act(async () => renderer.unmount());
  },
);

test.each(['remove', 'clear'] as const)(
  'a late %s failure still warns after the login screen unmounts',
  async action => {
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(() => undefined);
    let release!: (value: PasswordMemoryResult) => void;
    passwordNative[action].mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LoginScreen
          saving={false}
          onSubmit={jest.fn()}
          rememberedServers={[savedAccount()]}
          onProbeServerSecurity={async () => disabledSecurity}
        />,
      );
    });
    if (action === 'remove') {
      await act(async () => memoryToggle(renderer).props.onPress());
      await act(async () => memoryToggle(renderer).props.onPress());
    } else {
      await act(async () =>
        renderer.root
          .findByProps({
            accessibilityLabel: '清除已记住的账号密码',
          })
          .props.onPress(),
      );
    }
    expect(passwordNative[action]).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
    await act(async () => release({ available: true, ok: false }));
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith(
      action === 'remove' ? '未能取消密码记忆' : '未能清除账号密码',
      expect.stringContaining('旧密码可能仍保存在本机，请重试'),
    );
  },
);

test.each(['remove', 'clear'] as const)(
  'successful %s does not raise a failure alert',
  async action => {
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation(() => undefined);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <LoginScreen
          saving={false}
          onSubmit={jest.fn()}
          rememberedServers={[savedAccount()]}
          onProbeServerSecurity={async () => disabledSecurity}
        />,
      );
    });
    if (action === 'remove') {
      await act(async () => memoryToggle(renderer).props.onPress());
      await act(async () => memoryToggle(renderer).props.onPress());
    } else {
      await act(async () =>
        renderer.root
          .findByProps({
            accessibilityLabel: '清除已记住的账号密码',
          })
          .props.onPress(),
      );
    }
    expect(passwordNative[action]).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
    await act(async () => renderer.unmount());
  },
);

test('clearing a broken password entry rechecks secure storage and restores opt-in', async () => {
  passwordNative.get.mockResolvedValue({
    available: true,
    ok: false,
    password: null,
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <LoginScreen
        saving={false}
        onSubmit={jest.fn()}
        rememberedServers={[savedAccount()]}
        onProbeServerSecurity={async () => disabledSecurity}
      />,
    );
  });
  expect(memoryToggle(renderer).props.disabled).toBe(true);
  expect(passwordNative.status).toHaveBeenCalledTimes(1);
  await act(async () =>
    renderer.root
      .findByProps({
        accessibilityLabel: '清除已记住的账号密码',
      })
      .props.onPress(),
  );
  expect(passwordNative.clear).toHaveBeenCalledTimes(1);
  expect(passwordNative.status).toHaveBeenCalledTimes(2);
  expect(memoryToggle(renderer).props.disabled).toBe(false);
  await act(async () => renderer.unmount());
});

test('a failed server probe can recover without editing the restored address or account', async () => {
  const saved = savedAccount();
  const probe = jest
    .fn()
    .mockRejectedValueOnce(new Error('Synthetic offline'))
    .mockResolvedValue(disabledSecurity);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <LoginScreen
        saving={false}
        onSubmit={jest.fn()}
        rememberedServers={[saved]}
        lastServerURL={saved.serverURL}
        onProbeServerSecurity={probe}
      />,
    );
  });
  await finishProbe();
  await act(async () =>
    accountPassword(renderer).props.onChangeText('synthetic-manual-password'),
  );
  const submitButton = () =>
    renderer.root.findByProps({ accessibilityLabel: '登录 Cove' });
  expect(submitButton().props.disabled).toBe(true);
  const retry = renderer.root.findByProps({
    accessibilityLabel: '重试连接服务器',
  });
  await act(async () => {
    retry.props.onPress();
    retry.props.onPress();
  });
  expect(submitButton().props.disabled).toBe(true);
  await finishProbe();
  expect(probe).toHaveBeenCalledTimes(2);
  expect(probe).toHaveBeenLastCalledWith(saved.serverURL, false);
  expect(addressInput(renderer).props.value).toBe(saved.serverURL);
  expect(emailInput(renderer).props.value).toBe(saved.email);
  expect(accountPassword(renderer).props.value).toBe(
    'synthetic-manual-password',
  );
  expect(submitButton().props.disabled).toBe(false);
  expect(
    renderer.root.findAllByProps({
      accessibilityLabel: '重试连接服务器',
    }),
  ).toHaveLength(0);
  await act(async () => renderer.unmount());
});
