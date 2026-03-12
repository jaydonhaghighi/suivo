import * as Linking from 'expo-linking';

type OauthProvider = 'gmail' | 'outlook';

export function createMailboxOauthRedirectUri(provider: OauthProvider): string {
  return Linking.createURL('/mailboxes', {
    queryParams: {
      oauth_provider: provider
    }
  });
}
