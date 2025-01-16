import { useEffect } from 'react';

export default function PaymentSuccess() {
  useEffect(() => {
    console.log('[Payment Success] Closing payment window...');
    if (window.opener) {
      window.close();
    } else {
      window.location.href = '/';
    }
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="space-y-4 text-center">
        <p className="text-gray-600">Payment successful!</p>
        <p className="text-sm text-gray-400">You may close this window.</p>
      </div>
    </div>
  );
}
