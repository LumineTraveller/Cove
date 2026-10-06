
import TestRenderer, { act } from 'react-test-renderer';
import { Image, Text } from 'react-native';
import { Avatar } from '../src/features/profiles/components/Avatar';

test('falls back to initials when there is no avatar', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<Avatar username="Alice" />); });
  const texts = renderer.root.findAllByType(Text);
  expect(texts.some(node => node.props.children === 'AL')).toBe(true);
  expect(renderer.root.findAllByType(Image)).toHaveLength(0);
  await act(async () => renderer.unmount());
});

test('renders remote avatar images and strips crop metadata from the uri', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Avatar username="Bob" avatarUrl="data:image/png;base64,abc#cove-crop=0.1,0.2,1.5" />);
  });
  const image = renderer.root.findByType(Image);
  expect(image.props.source).toEqual({ uri: 'data:image/png;base64,abc' });
  await act(async () => renderer.unmount());
});
