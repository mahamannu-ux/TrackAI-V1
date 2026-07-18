'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import { supabase } from '@/lib/supabase';

export default function LoginPage() {
  const router = useRouter();

  // Redirect to dashboard if already logged in
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        router.push('/dashboard');
      }
    });

    return () => subscription.unsubscribe();
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-md">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">TrackAI</h1>
          <p className="text-gray-400 mt-2">Sign in to your account</p>
        </div>

        {/* Supabase Auth UI */}
        <div className="bg-gray-900 rounded-xl p-8 shadow-2xl border border-gray-800">
          <Auth
            supabaseClient={supabase}
            appearance={{
              theme: ThemeSupa,
              variables: {
                default: {
                  colors: {
                    brand: '#6366f1',
                    brandAccent: '#4f46e5',
                    inputBackground: '#1f2937',
                    inputText: '#f9fafb',
                    inputBorder: '#374151',
                    inputBorderFocus: '#6366f1',
                    inputBorderHover: '#4b5563',
                  },
                },
              },
            }}
            // Email/password authentication (enabled by default)
            // Enterprise SAML SSO provider
            providers={[]}
            // Show SAML/SSO button for enterprise login
            // Users click "Sign in with SSO" and enter their org's domain
            showLinks={true}
            view="sign_in"
          />

          {/* Enterprise SAML SSO Button */}
          <div className="mt-6 pt-6 border-t border-gray-700">
            <button
              onClick={() => {
                // Supabase SAML SSO: redirects to the identity provider
                // Configure your SAML provider in Supabase Dashboard → Authentication → SSO
                const domain = prompt('Enter your organization domain (e.g., company.com):');
                if (domain) {
                  supabase.auth.signInWithSSO({ domain }).then(({ data, error }) => {
                    if (error) {
                      alert(`SSO Error: ${error.message}`);
                    } else if (data?.url) {
                      window.location.href = data.url;
                    }
                  });
                }
              }}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg transition-colors border border-gray-600 hover:border-gray-500"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
              </svg>
              Enterprise SSO (SAML)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
