/**
 * Arkesel SMS Service Adapter
 * Provides integration with Arkesel SMS Gateway v2 (with v1 fallback)
 */

const DEFAULT_ARKESEL_KEY = 'a1FaWVVuVUhKZ3NPdFJhdE1Pd0w';
const DEFAULT_SENDER_ID = 'SMFI';

class ArkeselSmsService {
  constructor() {
    this.baseUrlV2 = 'https://sms.arkesel.com/api/v2';
    this.baseUrlV1 = 'https://sms.arkesel.com/sms/api';
    this.defaultApiKey = DEFAULT_ARKESEL_KEY;
    this.defaultSenderId = DEFAULT_SENDER_ID;
  }

  getApiKey(explicitKey) {
    let key = (explicitKey || process.env.ARKESEL_API_KEY || DEFAULT_ARKESEL_KEY).trim();
    // Strip surrounding quotes if pasted with quotes into environment variables
    if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
      key = key.slice(1, -1).trim();
    }
    if (!key || key === 'undefined' || key === 'null' || key === 'YOUR_ARKESEL_API_KEY') {
      key = DEFAULT_ARKESEL_KEY;
    }
    return key;
  }

  getSenderId(explicitSender) {
    let s = (explicitSender || process.env.ARKESEL_SENDER_ID || DEFAULT_SENDER_ID).trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1).trim();
    }
    return s.substring(0, 11) || DEFAULT_SENDER_ID;
  }

  /**
   * Cleans and standardizes phone number to international E.164 without leading '+'
   * e.g., '0544919953' -> '233544919953', '+233 24 123 4567' -> '233241234567'
   */
  formatPhoneNumber(rawPhone) {
    if (!rawPhone) return null;
    let clean = String(rawPhone).replace(/[^0-9+]/g, '').trim();

    if (clean.startsWith('+')) {
      clean = clean.substring(1);
    }

    if (clean.startsWith('0') && clean.length === 10) {
      // Ghana local 10-digit format (02X, 05X, 03X)
      clean = '233' + clean.substring(1);
    }

    return clean.length >= 9 ? clean : null;
  }

  /**
   * Retrieve real-time SMS and Main Credit balance from Arkesel
   */
  async checkBalance(explicitApiKey) {
    let apiKey = this.getApiKey(explicitApiKey);

    try {
      // 1. Try v2 balance endpoint first
      let v2Res = await fetch(`${this.baseUrlV2}/clients/balance-details`, {
        method: 'GET',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json'
        }
      });

      let data = await v2Res.json().catch(() => ({}));

      // If key was rejected as invalid and wasn't already default, retry with default SFMI key
      if ((v2Res.status === 401 || (data.message && data.message.toLowerCase().includes('invalid key'))) && apiKey !== DEFAULT_ARKESEL_KEY) {
        apiKey = DEFAULT_ARKESEL_KEY;
        v2Res = await fetch(`${this.baseUrlV2}/clients/balance-details`, {
          method: 'GET',
          headers: {
            'api-key': apiKey,
            'Content-Type': 'application/json'
          }
        });
        data = await v2Res.json().catch(() => ({}));
      }

      if (v2Res.ok && data && data.status === 'success' && data.data) {
        return {
          success: true,
          smsBalance: parseInt(data.data.sms_balance, 10) || 0,
          mainBalance: data.data.main_balance || 'GHS 0.00',
          currency: 'GHS',
          raw: data.data
        };
      }

      // 2. Fallback to v1 balance endpoint
      const v1Res = await fetch(`${this.baseUrlV1}?action=check-balance&api_key=${encodeURIComponent(apiKey)}&response=json`);
      if (v1Res.ok) {
        const v1Data = await v1Res.json().catch(() => ({}));
        if (v1Data.balance !== undefined) {
          return {
            success: true,
            smsBalance: parseInt(v1Data.balance, 10) || 0,
            mainBalance: v1Data.main_balance ? `GHS ${Number(v1Data.main_balance).toFixed(2)}` : 'GHS 0.00',
            currency: 'GHS',
            raw: v1Data
          };
        }
      }

      return {
        success: false,
        smsBalance: 0,
        mainBalance: 'GHS 0.00',
        error: data.message || 'Unable to query Arkesel balance endpoint'
      };
    } catch (err) {
      console.error('[ArkeselService] checkBalance error:', err.message);
      return {
        success: false,
        smsBalance: 0,
        mainBalance: 'GHS 0.00',
        error: err.message
      };
    }
  }

  /**
   * Send single or broadcast SMS
   * @param {Object} options
   * @param {string|string[]} options.recipients - Phone number or array of phone numbers
   * @param {string} options.message - SMS content
   * @param {string} [options.sender] - Sender ID (max 11 chars)
   * @param {string} [options.callbackUrl] - Webhook callback URL
   * @param {boolean} [options.sandbox=false] - Send in sandboxed test mode
   * @param {string} [options.apiKey] - Optional custom Arkesel API key
   */
  async sendSms({ recipients, message, sender, callbackUrl, sandbox = false, apiKey = null }) {
    if (!message || !message.trim()) {
      throw new Error('SMS message content cannot be empty');
    }

    let key = this.getApiKey(apiKey);
    const rawList = Array.isArray(recipients) ? recipients : [recipients];
    const cleanRecipients = rawList
      .map(p => this.formatPhoneNumber(p))
      .filter(Boolean);

    if (cleanRecipients.length === 0) {
      throw new Error('No valid recipient phone numbers provided');
    }

    const senderId = this.getSenderId(sender);

    try {
      const payload = {
        sender: senderId,
        message: message.trim(),
        recipients: cleanRecipients,
        sandbox: Boolean(sandbox)
      };

      if (callbackUrl) {
        payload.callback_url = callbackUrl;
      }

      // 1. Send via Arkesel v2 API
      let response = await fetch(`${this.baseUrlV2}/sms/send`, {
        method: 'POST',
        headers: {
          'api-key': key,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      let resData = await response.json().catch(() => ({}));

      // If key was rejected as invalid and wasn't already default, retry with default SFMI key
      if ((response.status === 401 || (resData.message && resData.message.toLowerCase().includes('invalid key'))) && key !== DEFAULT_ARKESEL_KEY) {
        console.warn('[ArkeselService] API key rejected. Retrying with default verified SFMI key...');
        key = DEFAULT_ARKESEL_KEY;
        response = await fetch(`${this.baseUrlV2}/sms/send`, {
          method: 'POST',
          headers: {
            'api-key': key,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload)
        });
        resData = await response.json().catch(() => ({}));
      }

      if (response.ok && (resData.status === 'success' || resData.code === 'ok')) {
        return {
          success: true,
          recipientCount: cleanRecipients.length,
          recipients: cleanRecipients,
          sender: senderId,
          data: resData
        };
      }

      // 2. Attempt v1 endpoint fallback
      const v1Url = `${this.baseUrlV1}?action=send-sms&api_key=${encodeURIComponent(key)}&to=${encodeURIComponent(cleanRecipients.join(','))}&from=${encodeURIComponent(senderId)}&sms=${encodeURIComponent(message.trim())}&response=json`;
      const v1Res = await fetch(v1Url);
      const v1Data = await v1Res.json().catch(() => ({}));

      if (v1Res.ok && (v1Data.code === 'ok' || v1Data.message === 'Successfully Sent')) {
        return {
          success: true,
          recipientCount: cleanRecipients.length,
          recipients: cleanRecipients,
          sender: senderId,
          data: v1Data
        };
      }

      throw new Error(resData.message || v1Data.message || resData.error || `Arkesel dispatch failed with HTTP ${response.status}`);
    } catch (err) {
      console.error('[ArkeselService] sendSms error:', err.message);
      throw err;
    }
  }

  /**
   * Dispatches personalized messages to a list of contacts
   * @param {Array<{phone: string, message: string, name?: string}>} contactMessages
   * @param {string} [sender]
   * @param {string} [apiKey]
   */
  async sendBulkPersonalizedSms(contactMessages = [], sender = null, apiKey = null) {
    const results = {
      total: contactMessages.length,
      sent: 0,
      failed: 0,
      details: []
    };

    // Process in batches of 10 to respect rate limits and keep response snappy
    const batchSize = 10;
    for (let i = 0; i < contactMessages.length; i += batchSize) {
      const batch = contactMessages.slice(i, i + batchSize);
      const promises = batch.map(async (item) => {
        try {
          const res = await this.sendSms({
            recipients: item.phone,
            message: item.message,
            sender: sender,
            apiKey: apiKey
          });
          results.sent++;
          results.details.push({
            phone: item.phone,
            name: item.name,
            success: true,
            res
          });
        } catch (err) {
          results.failed++;
          results.details.push({
            phone: item.phone,
            name: item.name,
            success: false,
            error: err.message
          });
        }
      });

      await Promise.all(promises);
    }

    return results;
  }
}

module.exports = new ArkeselSmsService();
