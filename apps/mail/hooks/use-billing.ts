/**
 * Self-hosted stub: all features are always unlocked.
 * No Autumn billing SDK dependency.
 */

type FeatureState = {
  total: number;
  remaining: number;
  unlimited: boolean;
  enabled: boolean;
  usage: number;
  nextResetAt: number | null;
  interval: string;
  included_usage: number;
};

const UNLIMITED: FeatureState = {
  total: 999999,
  remaining: 999999,
  unlimited: true,
  enabled: true,
  usage: 0,
  nextResetAt: null,
  interval: '',
  included_usage: 999999,
};

export const useBilling = () => {
  return {
    isLoading: false,
    customer: null,
    refetch: () => Promise.resolve(),
    attach: null,
    track: async () => {},
    openBillingPortal: () => {},
    isPro: true,
    chatMessages: UNLIMITED,
    connections: UNLIMITED,
    brainActivity: UNLIMITED,
  };
};
