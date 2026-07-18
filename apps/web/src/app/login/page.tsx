'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Auth } from '@supabase/auth-ui-react';
import { ThemeSupa } from '@supabase/auth-ui-shared';
import { supabase } from '@/lib/supabase';

export default function LoginPage() {
  const router = useRouter();
  const [isCheckingAuth, setIsCheckingAuth] = useState(true);

  // Phase 1.4 State Management Elements
  const [showSSOInput, setShowSSOInput] = useState(false);
  const [domainInput, setDomainInput] = useState('');
  const [ssoLoading, setSsoLoading] = useState(false);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        router.push('/update-password');
        return;
      }
      if (session) {
        router.push('/dashboard');
      } else {
        setIsCheckingAuth(false);
      }
    });

    return () => subscription.unsubscribe();
  }, [router]);

  // Refactored Multi-Tenant Dynamic Auth Router
  const executeSSOLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!domainInput.trim()) return;

    setSsoLoading(true);
    const targetDomain = domainInput.trim().toLowerCase();

    // Query your tenant table live
    const { data: tenantData } = await supabase
      .from('sso_tenants')
      .select('supabase_provider_id')
      .eq('domain', targetDomain)
      .maybeSingle();

    // Route A: Dynamic OIDC Handshake
    if (tenantData?.supabase_provider_id) {
      await supabase.auth.signInWithOAuth({
        provider: tenantData.supabase_provider_id as any,
        options: { redirectTo: `${window.location.origin}/dashboard` }
      });
      return;
    }

    // Route B: Standard SAML Fallback
    const { data, error } = await supabase.auth.signInWithSSO({ domain: targetDomain });
    if (error) {
      alert(`Enterprise Login Error: ${error.message}`);
      setSsoLoading(false);
    } else if (data?.url) {
      window.location.href = data.url;
    }
  };

  if (isCheckingAuth) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950">
        <p className="text-gray-400 animate-pulse">Loading secure workspace...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">TrackAI</h1>
          <p className="text-gray-400 mt-2">Sign in to your account</p>
        </div>

        <div className="bg-gray-900 rounded-xl p-8 shadow-2xl border border-gray-800">

          {!showSSOInput ? (
            <>
              {/* Default Form: Standard Email / Password Input Widget */}
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
                providers={[]}
                showLinks={true}
                view="sign_in"
              />

              <div className="mt-6 pt-6 border-t border-gray-700">
                <button
                  onClick={() => setShowSSOInput(true)}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-gray-800 hover:bg-gray-700 text-gray-200 rounded-lg transition-colors border border-gray-600 hover:border-gray-500"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                  </svg>
                  Enterprise SSO / OIDC Login
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Inline Input Form: Clean, native field container */}
              <form onSubmit={executeSSOLogin} className="flex flex-col gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-300 mb-2">Organization Domain</label>
                  <input
                    type="text"
                    placeholder="company.com"
                    value={domainInput}
                    onChange={(e) => setDomainInput(e.target.value)}
                    disabled={ssoLoading}
                    required
                    className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition-colors"
                  />
                </div>

                <button
                  type="submit"
                  disabled={ssoLoading}
                  className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-800 text-white font-medium rounded-lg transition-colors shadow-lg shadow-indigo-600/20"
                >
                  {ssoLoading ? 'Connecting to Identity Provider...' : 'Continue with Single Sign-On'}
                </button>

                <button
                  type="button"
                  onClick={() => { setShowSSOInput(false); setDomainInput(''); }}
                  disabled={ssoLoading}
                  className="w-full text-sm text-gray-400 hover:text-white transition-colors mt-2"
                >
                  &larr; Back to standard login
                </button>
              </form>
            </>
          )}

        </div>
      </div>
    </div>
  );
}
