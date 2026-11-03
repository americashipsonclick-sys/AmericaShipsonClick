import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { EquipmentType, User } from '../types/api';

interface DriveWithUsProps {
  onSuccessOnboard: (user: User) => void;
}

const LOCAL_STORAGE_KEY = 'americaships_driver_wizard_draft';

/**
 * Fields kept out of the resumable draft. Bank details are transient: they are
 * tokenized server-side on submit and are never meant to sit in localStorage,
 * where any script on the origin could read them back.
 */
const DRAFT_EXCLUDED_FIELDS = ['routing_number', 'account_number'] as const;

function persistDraft(
  data: Record<string, unknown>,
  step: number,
  accountCreated: boolean
) {
  const safe = { ...data } as Record<string, unknown>;
  DRAFT_EXCLUDED_FIELDS.forEach((field) => delete safe[field]);
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
    form: safe,
    step,
    accountCreated
  }));
}

export const DriveWithUs: React.FC<DriveWithUsProps> = ({ onSuccessOnboard }) => {
  const [step, setStep] = useState<number>(1);
  const [submitting, setSubmitting] = useState(false);
  const { data: catalog } = useQuery({
    queryKey: ['rates'],
    queryFn: () => api.getRates()
  });

  // Credentials live outside formData on purpose: formData is mirrored into
  // localStorage as a resumable draft, and a password does not belong there.
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // Step 1 creates the account, so uploads in later steps are authenticated.
  const [accountCreated, setAccountCreated] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Field validation errors
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Document scanning states
  const [uploadingField, setUploadingField] = useState<string | null>(null);
  const [scanStatus, setScanStatus] = useState<Record<string, string>>({});

  const [draftReady, setDraftReady] = useState(false);

  // Form State
  const [formData, setFormData] = useState({
    full_name: '',
    phone: '',
    email: '',
    home_base_city: 'Joplin',
    home_base_state: 'MO',
    cdl_number: '',
    cdl_class: 'A' as 'A' | 'B',
    dot_number: '',
    mc_number: '',
    equipment_type: 'dry_van' as EquipmentType,
    trailer_length_ft: 53,
    routing_number: '',
    account_number: '',
    same_day_funding_opt_in: false,
    cdl_photo_url: '',
    dot_authority_url: '',
    coi_url: ''
  });

  // Restore draft state from localStorage on mount
  useEffect(() => {
    const savedDraft = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (savedDraft) {
      try {
        const parsed = JSON.parse(savedDraft);
        if (parsed.form) {
          setFormData((prev) => ({ ...prev, ...parsed.form }));
          if (typeof parsed.step === 'number' && parsed.step >= 1 && parsed.step <= 4) {
            setStep(parsed.step);
          }
          if (parsed.accountCreated) setAccountCreated(true);
        } else {
          const { _wizardStep, _accountCreated, ...fields } = parsed;
          setFormData((prev) => ({ ...prev, ...fields }));
          if (typeof _wizardStep === 'number') setStep(_wizardStep);
          if (_accountCreated) setAccountCreated(true);
        }
      } catch {
        // ignore parse error
      }
    }
    setDraftReady(true);
  }, []);

  useEffect(() => {
    if (!draftReady) return;
    persistDraft(formData, step, accountCreated);
  }, [draftReady, formData, step, accountCreated]);

  const updateField = (field: string, value: unknown) => {
    setFormData((prev) => ({ ...prev, [field]: value }));

    // Clear error for field
    if (fieldErrors[field]) {
      setFieldErrors((prev) => {
        const copy = { ...prev };
        delete copy[field];
        return copy;
      });
    }
  };

  // Upload document file with OCR verification feedback
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>, fieldName: string) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadingField(fieldName);
    setScanStatus((prev) => ({ ...prev, [fieldName]: 'Uploading...' }));

    try {
      const res = await api.uploadFile(file);
      updateField(fieldName, res.file_url);
      setScanStatus((prev) => ({ ...prev, [fieldName]: 'Uploaded. Pending review.' }));
      setUploadingField(null);
    } catch (err: any) {
      alert(`File upload failed: ${err.message}`);
      setUploadingField(null);
      setScanStatus((prev) => ({ ...prev, [fieldName]: 'Upload failed' }));
    }
  };

  // Validate step 1: Profile
  const validateStep1 = (): boolean => {
    const errors: Record<string, string> = {};
    if (!formData.full_name || formData.full_name.trim().length < 2) {
      errors.full_name = 'Full name is required';
    }
    if (!formData.phone || formData.phone.replace(/\D/g, '').length < 10) {
      errors.phone = 'Valid 10-digit phone number is required';
    }
    const emailRegex = /^\S+@\S+\.\S+$/;
    if (!formData.email || !emailRegex.test(formData.email)) {
      errors.email = 'Valid email address is required';
    }
    if (!formData.home_base_city || formData.home_base_city.trim().length < 2) {
      errors.home_base_city = 'City is required';
    }
    if (!formData.home_base_state || formData.home_base_state.trim().length < 2) {
      errors.home_base_state = 'State code is required (e.g. MO)';
    }
    // Only enforced while the account is still being created; once it exists,
    // stepping back to edit profile fields must not demand the password again.
    if (!accountCreated) {
      if (password.length < 8) {
        errors.password = 'Password must be at least 8 characters';
      }
      if (password !== confirmPassword) {
        errors.confirm_password = 'Passwords do not match';
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Validate step 2: CDL & DOT
  const validateStep2 = (): boolean => {
    const errors: Record<string, string> = {};
    if (!formData.cdl_number || formData.cdl_number.trim().length < 4) {
      errors.cdl_number = 'CDL number is required';
    }
    if (!formData.dot_number || formData.dot_number.trim().length < 5) {
      errors.dot_number = 'USDOT number is required (min 5 digits)';
    }
    if (!formData.mc_number || formData.mc_number.trim().length < 4) {
      errors.mc_number = 'MC number is required';
    }
    if (!formData.cdl_photo_url) {
      errors.cdl_photo_url = 'CDL photo upload is required';
    }
    if (!formData.dot_authority_url) {
      errors.dot_authority_url = 'DOT Authority document upload is required';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Validate step 3: Equipment
  const validateStep3 = (): boolean => {
    const errors: Record<string, string> = {};
    if (!formData.trailer_length_ft || formData.trailer_length_ft < 10) {
      errors.trailer_length_ft = 'Valid trailer length is required';
    }
    if (!formData.coi_url) {
      errors.coi_url = 'Certificate of Insurance (COI) upload is required';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // Validate step 4: Payment
  const validateStep4 = (): boolean => {
    const errors: Record<string, string> = {};
    const cleanRouting = formData.routing_number.replace(/\D/g, '');
    if (!cleanRouting || cleanRouting.length !== 9) {
      errors.routing_number = 'Valid 9-digit ABA routing number is required';
    }
    const cleanAccount = formData.account_number.replace(/\D/g, '');
    if (!cleanAccount || cleanAccount.length < 4) {
      errors.account_number = 'Account number is required (min 4 digits)';
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleNext = async () => {
    setErrorMsg(null);
    let isValid = false;

    if (step === 1) isValid = validateStep1();
    else if (step === 2) isValid = validateStep2();
    else if (step === 3) isValid = validateStep3();
    else if (step === 4) isValid = validateStep4();

    if (!isValid) {
      setErrorMsg('Please correct the highlighted fields before proceeding.');
      return;
    }

    // The account is created before step 2 because the document uploads there
    // are authenticated. This also means the driver picks their own password
    // rather than being issued a shared one.
    if (step === 1 && !accountCreated) {
      setSubmitting(true);
      try {
        await api.signup({
          email: formData.email,
          password,
          role: 'driver',
          name: formData.full_name,
          phone: formData.phone,
          home_city: formData.home_base_city,
          home_state: formData.home_base_state
        });
        setAccountCreated(true);
        setPassword('');
        setConfirmPassword('');
      } catch (err: any) {
        setErrorMsg(
          err.message?.includes('already exists')
            ? 'An account with this email already exists. Sign in first, then finish onboarding.'
            : err.message || 'Could not create your account'
        );
        return;
      } finally {
        setSubmitting(false);
      }
    }

    if (step < 4) {
      setStep(step + 1);
    } else {
      handleSubmit();
    }
  };

  const handleBack = () => {
    setErrorMsg(null);
    setFieldErrors({});
    if (step > 1) setStep(step - 1);
  };

  const handleSubmit = async () => {
    if (!validateStep4()) {
      setErrorMsg('Please enter valid payment token credentials.');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      // Identity is carried by the token, so the payload describes the profile
      // only — there is no field here that names which driver to write to.
      const { email, phone, ...profile } = formData;
      await api.onboardDriver(profile);
      localStorage.removeItem(LOCAL_STORAGE_KEY);
      setSuccessMsg('Carrier profile saved. Documents are pending review — you can book loads while that runs.');

      // Refresh me details
      const me = await api.getMe();
      onSuccessOnboard(me.user);
    } catch (err: any) {
      setErrorMsg(err.message || 'Onboarding failed');
    } finally {
      setSubmitting(false);
    }
  };

  // Helper for bank lookup display
  const cleanRouting = formData.routing_number.replace(/\D/g, '');
  const isValidRouting = cleanRouting.length === 9;

  return (
    <div className="py-12 bg-[#F0EAD8] text-[#14171A]">
      <div className="max-w-190 mx-auto px-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <span className="eyebrow block">Drive With Us</span>
          <span className="stamp text-[0.78rem] border-[#0F5132] text-[#0F5132]">
            PENDING REVIEW
          </span>
        </div>

        <h2 className="text-3xl sm:text-4xl mb-2 font-serif font-black">Driver Onboarding</h2>
        <p className="text-[#5B6168] font-sans text-xs sm:text-sm mb-8">
          Four steps. Progress auto-saves as you type. Uploaded documents sit pending review — this wizard does not verify a carrier.
        </p>

        {/* Wizard Progress Bar */}
        <div className="flex justify-between border-2 border-[#14171A] mb-8 bg-[#FAFAF7] font-mono text-xs font-bold uppercase tracking-wider shadow-[4px_4px_0px_#14171A]">
          <div className={`flex-1 text-center py-2.5 border-r-2 border-[#14171A] ${step === 1 ? 'bg-[#E3A008] text-[#14171A]' : step > 1 ? 'bg-[#0F5132] text-[#F0EAD8]' : 'text-[#5B6168]'}`}>
            1 · Profile
          </div>
          <div className={`flex-1 text-center py-2.5 border-r-2 border-[#14171A] ${step === 2 ? 'bg-[#E3A008] text-[#14171A]' : step > 2 ? 'bg-[#0F5132] text-[#F0EAD8]' : 'text-[#5B6168]'}`}>
            2 · CDL / DOT
          </div>
          <div className={`flex-1 text-center py-2.5 border-r-2 border-[#14171A] ${step === 3 ? 'bg-[#E3A008] text-[#14171A]' : step > 3 ? 'bg-[#0F5132] text-[#F0EAD8]' : 'text-[#5B6168]'}`}>
            3 · Equipment
          </div>
          <div className={`flex-1 text-center py-2.5 ${step === 4 ? 'bg-[#E3A008] text-[#14171A]' : step > 4 ? 'bg-[#0F5132] text-[#F0EAD8]' : 'text-[#5B6168]'}`}>
            4 · Payment
          </div>
        </div>

        {errorMsg && (
          <div className="p-4 bg-[#8C2F1B]/10 border-2 border-[#8C2F1B] text-[#8C2F1B] font-mono text-xs mb-6 font-bold flex items-center gap-2">
            <span>⚠️</span> {errorMsg}
          </div>
        )}

        {successMsg && (
          <div className="p-4 bg-[#0F5132] text-[#F0EAD8] border-2 border-[#14171A] font-mono text-sm mb-6 shadow-[4px_4px_0px_#14171A]">
            <div className="font-bold text-base mb-1">PROFILE SAVED</div>
            <div>{successMsg}</div>
          </div>
        )}

        {/* Tactile Form Card */}
        <div className="bg-[#FAFAF7] border-2 border-[#14171A] p-6 shadow-[6px_6px_0px_#14171A]">
          {/* STEP 1: PROFILE */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="flex justify-between items-center mb-3 border-b-2 border-[#14171A] pb-2">
                <h3 className="text-xl font-serif font-black uppercase text-[#14171A]">Step 1: Driver Identity Profile</h3>
                <span className="font-mono text-[0.76rem] bg-[#E4DCC4] text-[#14171A] px-2 py-0.5 border border-[#14171A] font-bold">
                  STEP 1 OF 4
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                    Full Legal Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={formData.full_name}
                    onChange={(e) => updateField('full_name', e.target.value)}
                    placeholder="John Smith"
                    className={`w-full p-2.5 bg-[#F0EAD8] border-2 ${fieldErrors.full_name ? 'border-[#8C2F1B] bg-red-50' : 'border-[#14171A]'} text-xs font-mono focus:outline-none focus:bg-white`}
                  />
                  {fieldErrors.full_name && (
                    <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                      ✕ {fieldErrors.full_name}
                    </span>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                    Phone Number *
                  </label>
                  <input
                    type="tel"
                    required
                    value={formData.phone}
                    onChange={(e) => updateField('phone', e.target.value)}
                    placeholder="18005550199"
                    className={`w-full p-2.5 bg-[#F0EAD8] border-2 ${fieldErrors.phone ? 'border-[#8C2F1B] bg-red-50' : 'border-[#14171A]'} text-xs font-mono focus:outline-none focus:bg-white`}
                  />
                  {fieldErrors.phone && (
                    <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                      ✕ {fieldErrors.phone}
                    </span>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                  Email Address *
                </label>
                <input
                  type="email"
                  required
                  value={formData.email}
                  onChange={(e) => updateField('email', e.target.value)}
                  placeholder="john.smith@trucking.com"
                  className={`w-full p-2.5 bg-[#F0EAD8] border-2 ${fieldErrors.email ? 'border-[#8C2F1B] bg-red-50' : 'border-[#14171A]'} text-xs font-mono focus:outline-none focus:bg-white`}
                />
                {fieldErrors.email && (
                  <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                    ✕ {fieldErrors.email}
                  </span>
                )}
              </div>

              {!accountCreated && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                      Create Password *
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        autoComplete="new-password"
                        value={password}
                        onChange={(e) => {
                          setPassword(e.target.value);
                          setFieldErrors((prev) => {
                            const copy = { ...prev };
                            delete copy.password;
                            return copy;
                          });
                        }}
                        placeholder="Minimum 8 characters"
                        className={`w-full p-2.5 pr-16 bg-[#F0EAD8] border-2 ${fieldErrors.password ? 'border-[#8C2F1B] bg-red-50' : 'border-[#14171A]'} text-xs font-mono focus:outline-none focus:bg-white`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        aria-pressed={showPassword}
                        className="absolute inset-y-0 right-0 px-3 text-[0.7rem] font-mono font-bold uppercase text-[#5B6168] hover:text-[#14171A]"
                      >
                        {showPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    {fieldErrors.password && (
                      <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                        ✕ {fieldErrors.password}
                      </span>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                      Confirm Password *
                    </label>
                    <div className="relative">
                      <input
                        type={showPassword ? 'text' : 'password'}
                        required
                        autoComplete="new-password"
                        value={confirmPassword}
                        onChange={(e) => {
                          setConfirmPassword(e.target.value);
                          setFieldErrors((prev) => {
                            const copy = { ...prev };
                            delete copy.confirm_password;
                            return copy;
                          });
                        }}
                        placeholder="Re-enter password"
                        className={`w-full p-2.5 pr-16 bg-[#F0EAD8] border-2 ${fieldErrors.confirm_password ? 'border-[#8C2F1B] bg-red-50' : 'border-[#14171A]'} text-xs font-mono focus:outline-none focus:bg-white`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        aria-pressed={showPassword}
                        className="absolute inset-y-0 right-0 px-3 text-[0.7rem] font-mono font-bold uppercase text-[#5B6168] hover:text-[#14171A]"
                      >
                        {showPassword ? 'Hide' : 'Show'}
                      </button>
                    </div>
                    {fieldErrors.confirm_password && (
                      <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                        ✕ {fieldErrors.confirm_password}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {accountCreated && (
                <div className="border-2 border-[#0F5132] bg-[#E4DCC4] px-3 py-2">
                  <span className="font-mono text-[0.76rem] font-bold text-[#0F5132] uppercase">
                    ✓ Carrier account created — document uploads are now secured to your profile
                  </span>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                    Home Base City *
                  </label>
                  <input
                    type="text"
                    value={formData.home_base_city}
                    onChange={(e) => updateField('home_base_city', e.target.value)}
                    placeholder="Joplin"
                    className={`w-full p-2.5 bg-[#F0EAD8] border-2 ${fieldErrors.home_base_city ? 'border-[#8C2F1B] bg-red-50' : 'border-[#14171A]'} text-xs font-mono focus:outline-none focus:bg-white`}
                  />
                  {fieldErrors.home_base_city && (
                    <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                      ✕ {fieldErrors.home_base_city}
                    </span>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                    Home Base State *
                  </label>
                  <input
                    type="text"
                    maxLength={2}
                    value={formData.home_base_state}
                    onChange={(e) => updateField('home_base_state', e.target.value.toUpperCase())}
                    placeholder="MO"
                    className={`w-full p-2.5 bg-[#F0EAD8] border-2 ${fieldErrors.home_base_state ? 'border-[#8C2F1B] bg-red-50' : 'border-[#14171A]'} text-xs font-mono focus:outline-none focus:bg-white uppercase`}
                  />
                  {fieldErrors.home_base_state && (
                    <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                      ✕ {fieldErrors.home_base_state}
                    </span>
                  )}
                </div>
              </div>

              {/* Identity status */}
              <div className="p-3 bg-[#E4DCC4]/50 border-2 border-[#14171A] font-mono text-xs flex items-center justify-between mt-4">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 bg-[#E3A008] border border-[#14171A] inline-block"></span>
                  <span className="font-bold text-[#14171A]">Carrier documents:</span>
                  <span className="text-[#5B6168]">Uploaded files wait for review. Nothing here auto-approves you.</span>
                </div>
                <span className="text-[0.78rem] uppercase font-bold bg-[#14171A] text-[#F0EAD8] px-2 py-0.5">
                  STATUS: PENDING
                </span>
              </div>
            </div>
          )}

          {/* STEP 2: CDL & DOT */}
          {step === 2 && (
            <div className="space-y-5">
              <div className="flex justify-between items-center mb-3 border-b-2 border-[#14171A] pb-2">
                <h3 className="text-xl font-serif font-black uppercase text-[#14171A]">Step 2: CDL &amp; Authority Credentials</h3>
                <span className="font-mono text-[0.76rem] bg-[#E4DCC4] text-[#14171A] px-2 py-0.5 border border-[#14171A] font-bold">
                  STEP 2 OF 4
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                    CDL License Number *
                  </label>
                  <input
                    type="text"
                    value={formData.cdl_number}
                    onChange={(e) => updateField('cdl_number', e.target.value)}
                    placeholder="CDL-998811"
                    className={`w-full p-2.5 bg-[#F0EAD8] border-2 ${fieldErrors.cdl_number ? 'border-[#8C2F1B] bg-red-50' : 'border-[#14171A]'} text-xs font-mono focus:outline-none focus:bg-white`}
                  />
                  {fieldErrors.cdl_number && (
                    <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                      ✕ {fieldErrors.cdl_number}
                    </span>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                    CDL Class Designation
                  </label>
                  <select
                    value={formData.cdl_class}
                    onChange={(e) => updateField('cdl_class', e.target.value as 'A' | 'B')}
                    className="w-full p-2.5 bg-[#F0EAD8] border-2 border-[#14171A] text-xs font-mono focus:outline-none focus:bg-white"
                  >
                    <option value="A">Class A (Combination Vehicles)</option>
                    <option value="B">Class B (Heavy Straight Vehicles)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                    USDOT Number *
                  </label>
                    <input
                      type="text"
                      value={formData.dot_number}
                      onChange={(e) => updateField('dot_number', e.target.value)}
                      placeholder="3321100"
                      className={`w-full p-2.5 bg-[#F0EAD8] border-2 ${fieldErrors.dot_number ? 'border-[#8C2F1B] bg-red-50' : 'border-[#14171A]'} text-xs font-mono focus:outline-none focus:bg-white`}
                    />
                  {fieldErrors.dot_number && (
                    <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                      ✕ {fieldErrors.dot_number}
                    </span>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                    MC Motor Carrier Number *
                  </label>
                  <input
                    type="text"
                    value={formData.mc_number}
                    onChange={(e) => updateField('mc_number', e.target.value)}
                    placeholder="771120"
                    className={`w-full p-2.5 bg-[#F0EAD8] border-2 ${fieldErrors.mc_number ? 'border-[#8C2F1B] bg-red-50' : 'border-[#14171A]'} text-xs font-mono focus:outline-none focus:bg-white`}
                  />
                  {fieldErrors.mc_number && (
                    <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                      ✕ {fieldErrors.mc_number}
                    </span>
                  )}
                </div>
              </div>

              <p className="font-mono text-[0.76rem] text-[#5B6168]">
                USDOT and MC numbers are stored with your profile. They are not checked against FMCSA from this screen.
              </p>

              {/* Document Upload 1: CDL */}
              <div className="pt-2 border-t-2 border-[#14171A]/10">
                <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                  Upload CDL Front Photo *
                </label>
                <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    onChange={(e) => handleFileUpload(e, 'cdl_photo_url')}
                    className="w-full p-2 bg-[#F0EAD8] border-2 border-dashed border-[#14171A] text-xs font-mono cursor-pointer"
                  />
                  {uploadingField === 'cdl_photo_url' && (
                    <span className="text-xs font-mono text-[#E3A008] font-bold animate-pulse whitespace-nowrap">
                      Uploading...
                    </span>
                  )}
                </div>
                {scanStatus.cdl_photo_url && (
                  <span className="text-xs font-mono text-[#0F5132] font-bold block mt-1.5">
                    {scanStatus.cdl_photo_url}
                  </span>
                )}
                {fieldErrors.cdl_photo_url && (
                  <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                    ✕ {fieldErrors.cdl_photo_url}
                  </span>
                )}
              </div>

              {/* Document Upload 2: DOT Authority */}
              <div>
                <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                  Upload DOT Authority Grant Letter *
                </label>
                <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    onChange={(e) => handleFileUpload(e, 'dot_authority_url')}
                    className="w-full p-2 bg-[#F0EAD8] border-2 border-dashed border-[#14171A] text-xs font-mono cursor-pointer"
                  />
                  {uploadingField === 'dot_authority_url' && (
                    <span className="text-xs font-mono text-[#E3A008] font-bold animate-pulse whitespace-nowrap">
                      Uploading...
                    </span>
                  )}
                </div>
                {scanStatus.dot_authority_url && (
                  <span className="text-xs font-mono text-[#0F5132] font-bold block mt-1.5">
                    {scanStatus.dot_authority_url}
                  </span>
                )}
                {fieldErrors.dot_authority_url && (
                  <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                    ✕ {fieldErrors.dot_authority_url}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* STEP 3: EQUIPMENT */}
          {step === 3 && (
            <div className="space-y-5">
              <div className="flex justify-between items-center mb-3 border-b-2 border-[#14171A] pb-2">
                <h3 className="text-xl font-serif font-black uppercase text-[#14171A]">Step 3: Equipment &amp; Insurance</h3>
                <span className="font-mono text-[0.76rem] bg-[#E4DCC4] text-[#14171A] px-2 py-0.5 border border-[#14171A] font-bold">
                  STEP 3 OF 4
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                    Equipment Specification *
                  </label>
                  <select
                    value={formData.equipment_type}
                    onChange={(e) => updateField('equipment_type', e.target.value as EquipmentType)}
                    className="w-full p-2.5 bg-[#F0EAD8] border-2 border-[#14171A] text-xs font-mono focus:outline-none focus:bg-white"
                  >
                    {(catalog?.cards ?? []).map(c => (
                      <option key={c.equipment_key} value={c.equipment_key}>{c.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                    Trailer Length (ft) *
                  </label>
                  <input
                    type="number"
                    value={formData.trailer_length_ft}
                    onChange={(e) => updateField('trailer_length_ft', parseInt(e.target.value, 10) || 0)}
                    className={`w-full p-2.5 bg-[#F0EAD8] border-2 ${fieldErrors.trailer_length_ft ? 'border-[#8C2F1B] bg-red-50' : 'border-[#14171A]'} text-xs font-mono focus:outline-none focus:bg-white`}
                  />
                  {fieldErrors.trailer_length_ft && (
                    <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                      ✕ {fieldErrors.trailer_length_ft}
                    </span>
                  )}
                </div>
              </div>

              {/* COI Upload */}
              <div className="pt-2 border-t-2 border-[#14171A]/10">
                <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                  Upload Certificate of Insurance (COI) *
                </label>
                <div className="p-3 bg-[#E4DCC4]/30 border-2 border-[#14171A] mb-3 font-mono text-[0.78rem]">
                  <strong>Insurance Requirement Thresholds:</strong> Minimum $1,000,000 Commercial Auto Liability and $100,000 Motor Truck Cargo Coverage.
                </div>
                <input
                  type="file"
                  accept="image/*,application/pdf"
                  onChange={(e) => handleFileUpload(e, 'coi_url')}
                  className="w-full p-2 bg-[#F0EAD8] border-2 border-dashed border-[#14171A] text-xs font-mono cursor-pointer"
                />
                {uploadingField === 'coi_url' && (
                <span className="text-xs font-mono text-[#E3A008] font-bold animate-pulse block mt-1">
                  Uploading...
                </span>
                )}
                {scanStatus.coi_url && (
                  <span className="text-xs font-mono text-[#0F5132] font-bold block mt-1.5">
                    {scanStatus.coi_url}
                  </span>
                )}
                {fieldErrors.coi_url && (
                  <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                    ✕ {fieldErrors.coi_url}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* STEP 4: PAYMENT & AUDIT */}
          {step === 4 && (
            <div className="space-y-5">
              <div className="flex justify-between items-center mb-3 border-b-2 border-[#14171A] pb-2">
                <h3 className="text-xl font-serif font-black uppercase text-[#14171A]">Step 4: Tokenized Direct Settlement Setup</h3>
                <span className="font-mono text-[0.76rem] bg-[#E4DCC4] text-[#14171A] px-2 py-0.5 border border-[#14171A] font-bold">
                  STEP 4 OF 4
                </span>
              </div>

              <div className="p-3.5 bg-[#E3A008] text-[#14171A] border-2 border-[#14171A] font-mono text-xs shadow-[3px_3px_0px_#14171A]">
                <strong>Tokenized Stripe Connect Security:</strong> Bank routing and account numbers are encrypted immediately. Raw numbers are never stored in plain text.
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                    9-Digit Routing Number *
                  </label>
                  <input
                    type="text"
                    maxLength={9}
                    value={formData.routing_number}
                    onChange={(e) => updateField('routing_number', e.target.value)}
                    placeholder="111000025"
                    className={`w-full p-2.5 bg-[#F0EAD8] border-2 ${fieldErrors.routing_number ? 'border-[#8C2F1B] bg-red-50' : 'border-[#14171A]'} text-xs font-mono focus:outline-none focus:bg-white`}
                  />
                  {isValidRouting && (
                    <span className="text-[0.76rem] font-mono text-[#0F5132] font-bold mt-1 block">
                      ✓ 9-digit routing format
                    </span>
                  )}
                  {fieldErrors.routing_number && (
                    <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                      ✕ {fieldErrors.routing_number}
                    </span>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-mono font-bold uppercase text-[#14171A] mb-1">
                    Account Number *
                  </label>
                  <input
                    type="password"
                    value={formData.account_number}
                    onChange={(e) => updateField('account_number', e.target.value)}
                    placeholder="•••••••••"
                    className={`w-full p-2.5 bg-[#F0EAD8] border-2 ${fieldErrors.account_number ? 'border-[#8C2F1B] bg-red-50' : 'border-[#14171A]'} text-xs font-mono focus:outline-none focus:bg-white`}
                  />
                  {fieldErrors.account_number && (
                    <span className="text-[0.76rem] font-mono text-[#8C2F1B] font-bold mt-1 block">
                      ✕ {fieldErrors.account_number}
                    </span>
                  )}
                </div>
              </div>

              <div>
                <label className="flex items-center gap-2 cursor-pointer font-mono text-xs pt-1">
                  <input
                    type="checkbox"
                    checked={formData.same_day_funding_opt_in}
                    onChange={(e) => updateField('same_day_funding_opt_in', e.target.checked)}
                    className="w-4 h-4 accent-[#0F5132]"
                  />
                  <span className="font-bold">Opt-in for Same-Day Quick Pay Settlements (+3% fee)</span>
                </label>
              </div>

              {(() => {
                const checks = [
                  { label: 'Driver identity & contact', ok: Boolean(formData.full_name && formData.email) },
                  { label: 'CDL credentials', ok: Boolean(formData.cdl_number && formData.cdl_photo_url) },
                  { label: 'USDOT & MC numbers', ok: Boolean(formData.dot_number && formData.mc_number && formData.dot_authority_url) },
                  { label: 'Certificate of insurance', ok: Boolean(formData.coi_url) },
                  { label: 'Payout routing', ok: isValidRouting }
                ];
                const passed = checks.filter((c) => c.ok).length;
                return (
              <div className="mt-6 p-4 bg-[#14171A] text-[#F0EAD8] border-2 border-[#14171A] font-mono text-xs">
                <div className="font-bold uppercase tracking-wider text-[#E3A008] mb-3 pb-1 border-b border-[#F0EAD8]/20 flex justify-between">
                  <span>ONBOARDING CHECKLIST</span>
                  <span>{passed} / {checks.length} READY</span>
                </div>
                <div className="space-y-1.5 text-[0.8rem]">
                  {checks.map((c) => (
                    <div key={c.label} className="flex justify-between">
                      <span>{c.label}:</span>
                      <span className={c.ok ? 'text-emerald-400 font-bold' : 'text-[#E3A008] font-bold'}>
                        {c.ok ? 'RECORDED' : 'PENDING'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
                );
              })()}
            </div>
          )}

          {/* Navigation Controls */}
          <div className="flex justify-between items-center mt-8 pt-4 border-t-2 border-[#14171A]">
            <button
              type="button"
              onClick={handleBack}
              disabled={step === 1}
              className="btn ghost text-xs py-2.5 px-5 disabled:opacity-40 cursor-pointer"
            >
              Back
            </button>
            <button
              type="button"
              onClick={handleNext}
              disabled={submitting}
              className="btn primary text-xs py-2.5 px-6 cursor-pointer"
            >
              {submitting ? 'Submitting...' : step === 4 ? 'Save carrier profile' : 'Continue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
