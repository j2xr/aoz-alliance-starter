import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ToastProvider, useToast, showToast } from './Toast.jsx';

function Trigger({ type = 'info', message = 'Hello', duration }) {
  const toast = useToast();
  return (
    <button onClick={() => toast[type](message, duration)}>fire</button>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Toast', () => {
  it('renders a pushed toast message', () => {
    render(
      <ToastProvider>
        <Trigger type="success" message="Saved!" />
      </ToastProvider>,
    );

    act(() => screen.getByText('fire').click());

    expect(screen.getByText('Saved!')).toBeInTheDocument();
  });

  it('auto-dismisses after the given duration', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger type="error" message="Boom" duration={1000} />
      </ToastProvider>,
    );

    act(() => screen.getByText('fire').click());
    expect(screen.getByText('Boom')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByText('Boom')).not.toBeInTheDocument();
  });

  it('dismisses on close button click', () => {
    render(
      <ToastProvider>
        <Trigger type="info" message="Dismiss me" duration={0} />
      </ToastProvider>,
    );

    act(() => screen.getByText('fire').click());
    expect(screen.getByText('Dismiss me')).toBeInTheDocument();

    act(() => screen.getByLabelText('Dismiss').click());
    expect(screen.queryByText('Dismiss me')).not.toBeInTheDocument();
  });

  it('showToast reaches the mounted provider from outside a component', () => {
    render(<ToastProvider>{null}</ToastProvider>);

    act(() => showToast('From helpers.js', 'info'));

    expect(screen.getByText('From helpers.js')).toBeInTheDocument();
  });

  it('useToast throws outside a ToastProvider', () => {
    // Silence the expected React error-boundary console noise for this case.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Trigger />)).toThrow(/useToast must be used within a ToastProvider/);
    spy.mockRestore();
  });
});
