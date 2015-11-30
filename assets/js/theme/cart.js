import PageManager from '../page-manager';
import $ from 'jquery';
import _ from 'lodash';
import giftCertCheck from './common/gift-certificate-validator';
import utils from 'bigcommerce/stencil-utils';
import ShippingEstimator from './cart/shipping-estimator';

export default class Cart extends PageManager {
    loaded(next) {
        this.$cartContent = $('[data-cart-content]');
        this.$cartMessages = $('[data-cart-status]');
        this.$cartTotals = $('[data-cart-totals]');
        this.$overlay = $('[data-cart] .loadingOverlay')
            .hide(); // TODO: temporary until roper pulls in his cart components

        this.bindEvents();

        next();
    }

    cartUpdate($target) {
        const itemId = $target.data('cart-itemid');
        const $el = $('#qty-' + itemId);
        const oldQty = parseInt($el.val(), 10);
        const maxQty = parseInt($el.data('quantity-max'), 10);
        const minQty = parseInt($el.data('quantity-min'), 10);
        const minError = $el.data('quantity-min-error');
        const maxError = $el.data('quantity-max-error');
        const newQty = $target.data('action') === 'inc' ? oldQty + 1 : oldQty - 1;

        // Does not quality for min/max quantity
        if (newQty < minQty) {
            return alert(minError);
        } else if (newQty > maxQty) {
            return alert(maxError);
        }

        this.$overlay.show();

        utils.api.cart.itemUpdate(itemId, newQty, (err, response) => {
            this.$overlay.hide();

            if (response.data.status === 'succeed') {
                // if the quantity is changed "1" from "0", we have to remove the row.
                const remove = (newQty === 0);

                this.refreshContent(remove);
            } else {
                $el.val(oldQty);
                alert(response.data.errors.join('\n'));
            }
        });
    }

    cartRemoveItem(itemId) {
        this.$overlay.show();
        utils.api.cart.itemRemove(itemId, (err, response) => {
            if (response.data.status === 'succeed') {
                this.refreshContent(true);
            } else {
                alert(response.data.errors.join('\n'));
            }
        });
    }

    cartEditOptions(itemId) {
        const $modal = $('#modal');
        const $modalContent = $('.modal-content', $modal);
        const $modalOverlay = $('.loadingOverlay', $modal);
        const options = {
            template: 'cart/modals/configure-product',
        };

        // clear the modal
        $modalContent.html('');
        $modalOverlay.show();

        // open modal
        $modal.foundation('reveal', 'open');

        utils.api.productAttributes.configureInCart(itemId, options, (err, response) => {
            $modalOverlay.hide();
            $modalContent.html(response.content);

            this.bindGiftWrappingForm();
        });

        utils.hooks.on('product-option-change', (event, option) => {
            const $changedOption = $(option);
            const $form = $changedOption.parents('form');
            const $submit = $('input.button', $form);
            const $messageBox = $('.alertMessageBox');
            const item = $('[name="item_id"]', $form).attr('value');

            utils.api.productAttributes.optionChange(item, $form.serialize(), (err, result) => {
                const data = result.data || {};

                if (err) {
                    alert(err);
                    return false;
                }

                if (data.purchasing_message) {
                    $('p.alertBox-message', $messageBox).text(data.purchasing_message);
                    $submit.prop('disabled', true);
                    $messageBox.show();
                } else {
                    $submit.prop('disabled', false);
                    $messageBox.hide();
                }

                if (!data.purchasable || !data.instock) {
                    $submit.prop('disabled', true);
                } else {
                    $submit.prop('disabled', false);
                }
            });
        });
    }

    refreshContent(remove) {
        const $cartItemsRows = $('[data-item-row]', this.$cartContent);
        const $cartPageTitle = $('[data-cart-page-title]');
        const options = {
            template: {
                content: 'cart/content',
                totals: 'cart/totals',
                pageTitle: 'cart/page-title',
                statusMessages: 'cart/status-messages',
            },
        };

        this.$overlay.show();

        // Remove last item from cart? Reload
        if (remove && $cartItemsRows.length === 1) {
            return window.location.reload();
        }

        utils.api.cart.getContent(options, (err, response) => {
            this.$cartContent.html(response.content);
            this.$cartTotals.html(response.totals);
            this.$cartMessages.html(response.statusMessages);

            $cartPageTitle.replaceWith(response.pageTitle);
            this.bindEvents();
            this.$overlay.hide();

            const quantity = $('[data-cart-quantity]', this.$cartContent).data('cart-quantity') || 0;

            $('body').trigger('cart-quantity-update', quantity);
        });
    }

    bindCartEvents() {
        const debounceTimeout = 400;
        const cartUpdate = _.bind(_.debounce(this.cartUpdate, debounceTimeout), this);
        const cartRemoveItem = _.bind(_.debounce(this.cartRemoveItem, debounceTimeout), this);

        // cart update
        $('[data-cart-update]', this.$cartContent).on('click', (event) => {
            const $target = $(event.currentTarget);

            event.preventDefault();

            // update cart quantity
            cartUpdate($target);
        });

        $('.cart-remove', this.$cartContent).on('click', (event) => {
            const itemId = $(event.currentTarget).data('cart-itemid');
            const openTime = new Date();
            const result = confirm($(event.currentTarget).data('confirm-delete'));
            const delta = new Date() - openTime;
            event.preventDefault();

            // Delta workaround for Chrome's "prevent popup"
            if (!result && delta > 10) {
                return;
            }

            // remove item from cart
            cartRemoveItem(itemId);
        });

        $('[data-item-edit]', this.$cartContent).on('click', (event) => {
            const itemId = $(event.currentTarget).data('item-edit');

            event.preventDefault();
            // edit item in cart
            this.cartEditOptions(itemId);
        });
    }

    bindPromoCodeEvents() {
        const $couponContainer = $('.coupon-code');
        const $couponForm = $('.coupon-form');
        const $codeInput = $('[name="couponcode"]', $couponForm);

        $('.coupon-code-add').on('click', (event) => {
            event.preventDefault();

            $(event.currentTarget).hide();
            $couponContainer.show();
            $('.coupon-code-cancel').show();
            $codeInput.focus();
        });

        $('.coupon-code-cancel').on('click', (event) => {
            event.preventDefault();

            $couponContainer.hide();
            $('.coupon-code-cancel').hide();
            $('.coupon-code-add').show();
        });

        $couponForm.on('submit', (event) => {
            const code = $codeInput.val();

            event.preventDefault();

            // Empty code
            if (!code) {
                return alert($codeInput.data('error'));
            }

            utils.api.cart.applyCode(code, (err, response) => {
                if (response.data.status === 'success') {
                    this.refreshContent();
                } else {
                    alert(response.data.errors.join('\n'));
                }
            });
        });
    }

    bindGiftCertificateEvents() {
        const $certContainer = $('.gift-certificate-code');
        const $certForm = $('.cart-gift-certificate-form');
        const $certInput = $('[name="certcode"]', $certForm);

        $('.gift-certificate-add').on('click', (event) => {
            event.preventDefault();
            $(event.currentTarget).toggle();
            $certContainer.toggle();
            $('.gift-certificate-cancel').toggle();
        });

        $('.gift-certificate-cancel').on('click', (event) => {
            event.preventDefault();
            $certContainer.toggle();
            $('.gift-certificate-add').toggle();
            $('.gift-certificate-cancel').toggle();
        });

        $certForm.on('submit', (event) => {
            const code = $certInput.val();

            event.preventDefault();

            if (!giftCertCheck(code)) {
                return alert($certInput.data('error'));
            }

            utils.api.cart.applyGiftCertificate(code, (err, resp) => {
                if (resp.data.status === 'success') {
                    this.refreshContent();
                } else {
                    alert(resp.data.errors.join('\n'));
                }
            });
        });
    }

    bindGiftWrappingEvents() {
        const $modal = $('#modal');
        const $modalContent = $('.modal-content', $modal);
        const $modalOverlay = $('.loadingOverlay', $modal);

        $('[data-item-giftwrap]').on('click', (event) => {
            const itemId = $(event.currentTarget).data('item-giftwrap');
            const options = {
                template: 'cart/modals/gift-wrapping-form',
            };

            event.preventDefault();

            // clear the modal
            $modalContent.html('');
            $modalOverlay.show();

            // open modal
            $modal.foundation('reveal', 'open');

            utils.api.cart.getItemGiftWrappingOptions(itemId, options, (err, response) => {
                $modalOverlay.hide();
                $modalContent.html(response.content);

                this.bindGiftWrappingForm();
            });
        });
    }

    bindGiftWrappingForm() {
        $('.giftWrapping-select').change((event) => {
            const $select = $(event.currentTarget);
            const id = $select.val();
            const index = $select.data('index');

            if (!id) {
                return;
            }

            const allowMessage = $select.find('option[value=' + id + ']').data('allow-message');

            $('.giftWrapping-image-' + index).hide();
            $('#giftWrapping-image-' + index + '-' + id).show();

            if (allowMessage) {
                $('#giftWrapping-message-' + index).show();
            } else {
                $('#giftWrapping-message-' + index).hide();
            }
        });

        $('.giftWrapping-select').trigger('change');

        function toggleViews() {
            const value = $('input:radio[name ="giftwraptype"]:checked').val();
            const $singleForm = $('.giftWrapping-single');
            const $multiForm = $('.giftWrapping-multiple');

            if (value === 'same') {
                $singleForm.show();
                $multiForm.hide();
            }  else {
                $singleForm.hide();
                $multiForm.show();
            }
        }

        $('[name="giftwraptype"]').click(toggleViews);

        toggleViews();
    }

    bindEvents() {
        this.bindCartEvents();
        this.bindPromoCodeEvents();
        this.bindGiftWrappingEvents();
        this.bindGiftCertificateEvents();

        // initiate shipping estimator module
        this.shippingEstimator = new ShippingEstimator($('[data-shipping-estimator]'));
    }
}
